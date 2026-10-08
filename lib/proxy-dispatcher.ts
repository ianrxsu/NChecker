import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch, type Dispatcher } from "undici"
import { SocksClient } from "socks"
import type { ParsedProxy, ProxyDialInfo } from "@/lib/proxies"
import { proxyUrl } from "@/lib/proxies"

// Builds and caches one undici Dispatcher per configured proxy so the checker
// can route Netflix requests through rotating exit IPs. HTTP/HTTPS proxies use
// undici's built-in ProxyAgent; SOCKS5 proxies use a custom undici connector
// backed by the `socks` package. Dispatchers are cached by proxy id (keyed with
// the endpoint signature) so warm connections are reused across requests.

type CacheEntry = { signature: string; dispatcher: Dispatcher }
const cache = new Map<string, CacheEntry>()

// How long to wait for a proxy to OPEN a connection before treating it as dead.
// Kept tight (vs. the per-request timeout) so failover to the next working proxy
// happens fast — a stuck dial must never hold a cookie hostage. Live proxies are
// pre-verified reachable, so a healthy one connects well under this.
const CONNECT_TIMEOUT_MS = 7_000

// SECURITY — DO NOT CHANGE rejectUnauthorized TO false.
// This is what keeps cookies safe when routing through UNTRUSTED public proxies.
// Because rejectUnauthorized is true, the TLS handshake is performed and verified
// against Netflix's real certificate END TO END — the proxy only ever relays an
// opaque, encrypted tunnel and can never read the NetflixId / SecureNetflixId
// cookies. Setting this to false (a tempting "fix" for proxies that throw cert
// errors) would let a malicious proxy man-in-the-middle the connection with a
// forged cert and steal every cookie. A cert error means the PROXY is hostile or
// broken — fail the request and move on, never weaken verification.
const SECURE_TLS_OPTIONS = { rejectUnauthorized: true } as const

// Shared TLS connector (verifies Netflix's cert after the SOCKS tunnel opens).
const tlsConnector = buildConnector({ timeout: CONNECT_TIMEOUT_MS, ...SECURE_TLS_OPTIONS })

function signatureOf(p: ProxyDialInfo): string {
  return `${p.protocol}://${p.username ?? ""}:${p.password ? "x" : ""}@${p.host}:${p.port}`
}

// undici connector that opens a SOCKS5 tunnel to the target, then upgrades to
// TLS for https origins. Mirrors what socks-proxy-agent does, but as a native
// undici connector so it shares the Agent's pooling/keep-alive.
function socksConnector(p: ProxyDialInfo): buildConnector.connector {
  return (async (options: buildConnector.Options, callback: buildConnector.Callback) => {
    const { hostname, port, protocol } = options
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: p.host,
          port: p.port,
          type: 5,
          userId: p.username ?? undefined,
          password: p.password ?? undefined,
        },
        command: "connect",
        destination: {
          host: hostname,
          port: Number(port) || (protocol === "https:" ? 443 : 80),
        },
        timeout: CONNECT_TIMEOUT_MS,
      })

      if (protocol === "https:") {
        // Hand the raw SOCKS socket to undici's TLS connector to complete the
        // HTTPS handshake against Netflix.
        return tlsConnector({ ...options, httpSocket: socket }, callback)
      }
      callback(null, socket)
    } catch (err) {
      callback(err as Error, null)
    }
  }) as unknown as buildConnector.connector
}

function buildDispatcher(p: ProxyDialInfo): Dispatcher {
  const opts = {
    connections: 10, // per-proxy socket pool ≈ "threads per proxy" toward Netflix
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 4_000,
    pipelining: 1,
  }
  if (p.protocol === "socks5") {
    return new Agent({ ...opts, connect: socksConnector(p) })
  }
  // http / https forward proxy. Bound the connect phase so a dead proxy fails over
  // fast instead of hanging on the default (much longer) TCP timeout. The connect
  // options also carry SECURE_TLS_OPTIONS so the TLS handshake undici performs to
  // Netflix THROUGH the proxy's CONNECT tunnel verifies the real certificate — the
  // forward proxy only relays encrypted bytes and cannot read the cookies.
  return new ProxyAgent({
    ...opts,
    uri: proxyUrl(p),
    connect: { timeout: CONNECT_TIMEOUT_MS, ...SECURE_TLS_OPTIONS },
  })
}

// Returns a cached (or freshly built) dispatcher for the given proxy. Rebuilds
// when the proxy's endpoint/credentials change.
export function dispatcherForProxy(p: ProxyDialInfo): Dispatcher {
  const signature = signatureOf(p)
  const existing = cache.get(p.id)
  if (existing && existing.signature === signature) return existing.dispatcher
  if (existing) void existing.dispatcher.close().catch(() => {})
  const dispatcher = buildDispatcher(p)
  cache.set(p.id, { signature, dispatcher })
  return dispatcher
}

// Drops dispatchers whose proxy id is no longer in the active set (so removed/
// disabled proxies don't leak sockets).
export function pruneDispatchers(activeIds: Set<string>): void {
  for (const [id, entry] of cache) {
    if (!activeIds.has(id)) {
      void entry.dispatcher.close().catch(() => {})
      cache.delete(id)
    }
  }
}

// ---- Active reachability test -------------------------------------------
// Lightweight target the checker actually depends on. A proxy that can't open
// an HTTPS connection to Netflix's edge and get a response is useless here, no
// matter how fast it is to a generic speed-test endpoint.
const TEST_URL = "https://www.netflix.com/login"
// Tighter ceiling: a proxy that can't reach Netflix within ~5s is too slow to be
// useful for the multi-request cookie-check flow anyway (it's at/over the sweep's
// default "too slow" cutoff), and waiting longer just makes the sweep drag on
// dead proxies. Lowering this directly shortens how long each sweep spends on
// unreachable proxies.
const TEST_TIMEOUT_MS = 6_000
// ACCURACY: a single probe is noisy — a working proxy can lose one request to a
// transient blip (packet loss, a momentary Netflix 503, a cold socket). So we
// never condemn a proxy on one failure: we retry transient/transport failures up
// to this many attempts and trust the FIRST success. This is the core guard
// against discarding proxies that actually work.
const MAX_PROBE_ATTEMPTS = 3
// Short backoff between attempts so a brief network hiccup has time to clear
// without dragging the sweep out on genuinely dead proxies.
const PROBE_RETRY_BACKOFF_MS = 400
// Proxies whose exit IP Netflix is actively challenging (403/429) still WORK as
// relays — they reached Netflix and got a response. We keep them, but add this
// latency penalty when recording health so clean, unchallenged proxies always
// sort ahead of them ("fastest healthy first").
export const FLAGGED_LATENCY_PENALTY_MS = 3_000

export type ProxyTestResult = {
  ok: boolean
  latencyMs: number
  status?: number
  reason?: string
  attempts?: number
  // Reachable, but Netflix challenged the exit IP (HTTP 403/429). The proxy works
  // as a relay; callers should keep it but rank it below clean proxies.
  flagged?: boolean
}

// One probe attempt, classified three ways:
//  - reachable: Netflix responded through the proxy (it works; maybe flagged).
//  - transient: a failure that MIGHT clear on a retry (timeout, reset, hang-up,
//    gateway 5xx) — worth another attempt before condemning the proxy.
//  - hard: a failure that won't recover in-window (connection refused, DNS
//    failure, host/network unreachable, TLS error, proxy-auth 407) — fail fast
//    so dead proxies don't slow the sweep.
type AttemptOutcome =
  | { kind: "reachable"; latencyMs: number; status: number; flagged: boolean }
  | { kind: "transient"; latencyMs: number; reason: string }
  | { kind: "hard"; latencyMs: number; reason: string }

// Error signatures that indicate a permanently-dead proxy (no point retrying).
const HARD_ERROR_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPROTO|ERR_TLS|certificate|self.?signed|unable to verify/i

async function probeAttempt(dispatcher: Dispatcher, timeoutMs: number): Promise<AttemptOutcome> {
  const t0 = Date.now()
  try {
    const res = await undiciFetch(TEST_URL, {
      method: "GET",
      redirect: "manual",
      dispatcher,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html",
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - t0
    // Drain so the socket can be reused/closed cleanly.
    void res.body?.cancel().catch(() => {})
    // Gateway failures: the proxy or an upstream hop failed to deliver — often
    // transient, so allow a retry.
    if ([502, 503, 504].includes(res.status)) {
      return { kind: "transient", latencyMs, reason: `gateway ${res.status}` }
    }
    // Proxy auth required/failed — a credential problem that won't fix itself.
    if (res.status === 407) return { kind: "hard", latencyMs, reason: "proxy auth (407)" }
    // 403/429: Netflix answered through the proxy but is challenging the exit IP.
    // The proxy WORKS as a relay, so this counts as reachable (just flagged).
    const flagged = res.status === 403 || res.status === 429
    return { kind: "reachable", latencyMs, status: res.status, flagged }
  } catch (err) {
    const latencyMs = Date.now() - t0
    const msg = err instanceof Error ? err.message : "connection failed"
    if (/timed out|aborted/i.test(msg)) return { kind: "transient", latencyMs, reason: "timed out" }
    if (HARD_ERROR_RE.test(msg)) return { kind: "hard", latencyMs, reason: "unreachable" }
    // Unknown errors (e.g. ECONNRESET, socket hang up) are treated as transient —
    // lean toward giving a possibly-working proxy another chance.
    return { kind: "transient", latencyMs, reason: "connection reset" }
  }
}

// Robust core probe. Returns on the FIRST reachable response and retries only
// TRANSIENT failures (up to MAX_PROBE_ATTEMPTS); hard failures bail immediately
// so dead proxies stay fast. Reports the best (lowest) latency seen so a single
// slow attempt can't get a good proxy wrongly flagged "too slow". Never throws.
// Options to tune the probe per use-case. The LIVE proxy sweep wants to surface
// the first working proxy FAST (it re-polls continuously, so a proxy missed this
// sweep is retested moments later) and therefore uses a SINGLE attempt with a
// short timeout. The persisted-proxy health check wants ACCURACY and keeps the
// robust multi-attempt default.
export type ProbeOptions = { maxAttempts?: number; timeoutMs?: number }

async function probeNetflix(dispatcher: Dispatcher, opts?: ProbeOptions): Promise<ProxyTestResult> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? MAX_PROBE_ATTEMPTS)
  const timeoutMs = opts?.timeoutMs ?? TEST_TIMEOUT_MS
  let lastReason = "unreachable"
  let bestLatency = Number.POSITIVE_INFINITY
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await probeAttempt(dispatcher, timeoutMs)
    bestLatency = Math.min(bestLatency, out.latencyMs)
    if (out.kind === "reachable") {
      return { ok: true, latencyMs: bestLatency, status: out.status, flagged: out.flagged, attempts: attempt }
    }
    lastReason = out.reason
    // A hard failure won't recover — condemn the proxy now without burning retries.
    if (out.kind === "hard") {
      return { ok: false, latencyMs: bestLatency, reason: lastReason, attempts: attempt }
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, PROBE_RETRY_BACKOFF_MS))
    }
  }
  return {
    ok: false,
    latencyMs: Number.isFinite(bestLatency) ? bestLatency : timeoutMs,
    reason: lastReason,
    attempts: maxAttempts,
  }
}

// Probes an already-persisted proxy (reuses its cached, keep-alive dispatcher).
export async function testProxyReachability(p: ProxyDialInfo, opts?: ProbeOptions): Promise<ProxyTestResult> {
  return probeNetflix(dispatcherForProxy(p), opts)
}

// Probes a freshly-PARSED proxy BEFORE it's ever persisted — used by the scraper
// so only proxies that actually reach Netflix get written to the database. Builds
// a one-off dispatcher (NOT cached by id, since there's no id yet) and always
// closes it so probing thousands of candidates can't leak sockets or poison the
// id-keyed cache used by the live checker.
export async function testParsedProxyReachability(p: ParsedProxy, opts?: ProbeOptions): Promise<ProxyTestResult> {
  const dispatcher = buildDispatcher({
    id: "__probe__",
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
  })
  try {
    return await probeNetflix(dispatcher, opts)
  } finally {
    void dispatcher.close().catch(() => {})
  }
}
