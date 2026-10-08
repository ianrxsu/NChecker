// Browser-session-local ephemeral proxy pool. While a check run is active the
// client continuously polls /api/proxies/live (which scrapes + reachability-tests
// in memory and returns the fastest survivors), accumulating them HERE — in this
// tab's memory only. Nothing is persisted to the database: free proxies die fast,
// so the pool is kept fresh by dropping stale entries and re-polling, and the
// fastest-first slice is handed to every /api/check call so the server dials this
// session's OWN freshly-verified exit IPs.

export type LiveProxyWire = { protocol: "http" | "https" | "socks5"; host: string; port: number }
type LiveProxy = LiveProxyWire & { latencyMs: number; addedAt: number }

const pool = new Map<string, LiveProxy>()
// Keep the pool bounded to the fastest N so memory and per-request payloads stay
// small even after many polls. Turbo mode (large runs, 100+ cookies) keeps a much
// bigger pool so concurrency can scale with the number of WORKING proxies.
const MAX_POOL_STANDARD = 200
const MAX_POOL_TURBO = 800
// Free proxies decay quickly; anything we verified more than a few minutes ago is
// assumed dead and dropped so we never dial stale IPs.
const MAX_AGE_MS = 4 * 60_000
// Standard runs poll gently; turbo runs poll aggressively so the working-proxy
// pool fills fast and stays FRESH (each poll scrapes + Netflix-tests a new
// candidate batch). Kept short so newly-verified fast proxies become available
// almost immediately and the run is never starved of fresh exit IPs.
const POLL_INTERVAL_STANDARD_MS = 4_000
const POLL_INTERVAL_TURBO_MS = 1_500

// Live mode, set by the active run. Turbo = a large (100+) run that wants the
// continuous high-volume scrape and proxy-count-scaled concurrency.
let turbo = false
const maxPool = () => (turbo ? MAX_POOL_TURBO : MAX_POOL_STANDARD)
const pollInterval = () => (turbo ? POLL_INTERVAL_TURBO_MS : POLL_INTERVAL_STANDARD_MS)

let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
let refCount = 0

function keyOf(p: { protocol: string; host: string; port: number }): string {
  return `${p.protocol}:${p.host}:${p.port}`
}

function prune(): void {
  const now = Date.now()
  for (const [k, p] of pool) if (now - p.addedAt > MAX_AGE_MS) pool.delete(k)
  const cap = maxPool()
  if (pool.size > cap) {
    const sorted = [...pool.entries()].sort((a, b) => a[1].latencyMs - b[1].latencyMs)
    pool.clear()
    for (const [k, p] of sorted.slice(0, cap)) pool.set(k, p)
  }
}

// Adds one streamed proxy to the pool the moment it arrives.
function addProxy(p: Partial<LiveProxyWire> & { latencyMs?: number }): void {
  if (!p?.host || !p?.port || !p?.protocol) return
  pool.set(keyOf(p as LiveProxyWire), {
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : 9999,
    addedAt: Date.now(),
  })
}

async function poll(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    // Low priority so the browser always favours the /api/check connections for
    // bandwidth and its per-origin connection slots.
    const res = await fetch("/api/proxies/live", {
      method: "POST",
      priority: "low",
      headers: { "Content-Type": "application/json" },
    } as RequestInit)
    if (!res.ok || !res.body) return

    // The route streams NDJSON — one verified proxy per line, flushed as soon as
    // it passes its Netflix test. Read incrementally and add each proxy to the pool
    // RIGHT AWAY so the run gets fresh exit IPs without waiting for the whole sweep.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const obj = JSON.parse(trimmed) as { type?: string; protocol?: string; host?: string; port?: number; latencyMs?: number }
        if (obj.type === "proxy") addProxy(obj as LiveProxyWire & { latencyMs?: number })
      } catch {
        // ignore malformed line
      }
    }
    let added = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
        added++
      }
      // Keep the pool trimmed to fastest-N as it grows mid-stream.
      if (added && added % 25 === 0) prune()
    }
    if (buf) handleLine(buf) // trailing partial line
    prune()
  } catch {
    // best-effort: a failed poll never affects the run itself
  } finally {
    inFlight = false
  }
}

// (Re)starts the polling loop at the cadence for the requested mode. Turbo mode
// (large 100+ runs) polls aggressively and keeps a bigger pool; standard mode
// polls gently. Switching modes restarts the timer at the new interval.
function ensureTimer(): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => void poll(), pollInterval())
}

// Reference-counted so the single checker and bulk checker can both keep it
// running without stepping on each other; the loop stops only once nobody needs it.
export function startLiveProxies(opts?: { turbo?: boolean }): void {
  const wantTurbo = opts?.turbo === true
  // Once any active run requests turbo, stay in turbo until everyone stops.
  const modeChanged = wantTurbo && !turbo
  if (wantTurbo) turbo = true
  refCount++
  if (timer && !modeChanged) return
  void poll()
  ensureTimer()
}

export function stopLiveProxies(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount > 0) return
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Reset mode once no run is active so the next small run starts gently.
  turbo = false
}

// How aggressively to favour freshly-verified proxies. A proxy verified within
// RECENCY_WINDOW_MS gets up to RECENCY_CREDIT_MS shaved off its effective latency
// when ranking, so a just-scraped "latest" exit IP surfaces into the slice ahead
// of stale-but-marginally-faster entries — without overriding genuinely fast
// proxies. This is the "use the fastest AND the latest" ranking.
const RECENCY_WINDOW_MS = 45_000
const RECENCY_CREDIT_MS = 1_500

// SECURITY/QUALITY penalty (ms) added to the rank score of plain-HTTP forward
// proxies so encrypted-transport proxies (SOCKS5, and HTTPS CONNECT proxies) are
// preferred when available. Cookies stay protected on ANY scheme because the
// request to Netflix is HTTPS end-to-end (see proxy-dispatcher's SECURE_TLS_OPTIONS),
// but plain-HTTP forward proxies are the type most commonly run to intercept/inject
// traffic, so we dial them last while still keeping them as fallback. Modest so a
// genuinely fast HTTP proxy can still beat a slow SOCKS5 one.
const HTTP_PROXY_PENALTY_MS = 600

// Effective ranking score: lower is better. Fast latency dominates, but recent
// proxies get a small credit so newly-arrived working exit IPs are picked up
// immediately instead of waiting behind a saturated fastest-N list, and plain-HTTP
// proxies take a small penalty so more-trustworthy transports are tried first.
function rankScore(p: LiveProxy, now: number): number {
  const age = now - p.addedAt
  const credit = age < RECENCY_WINDOW_MS ? (1 - age / RECENCY_WINDOW_MS) * RECENCY_CREDIT_MS : 0
  const schemePenalty = p.protocol === "http" ? HTTP_PROXY_PENALTY_MS : 0
  return p.latencyMs - credit + schemePenalty
}

// Fastest-AND-latest-first slice for the next /api/check call (protocol/host/port
// only). Turbo runs ship a much larger slice so the server can round-robin a
// different exit IP per cookie across many proxies (≈ "N threads per proxy").
export function getLiveProxySlice(limit = turbo ? 300 : 150): LiveProxyWire[] {
  prune()
  const now = Date.now()
  return [...pool.values()]
    .sort((a, b) => rankScore(a, now) - rankScore(b, now))
    .slice(0, limit)
    .map((p) => ({ protocol: p.protocol, host: p.host, port: p.port }))
}

export function liveProxyCount(): number {
  prune()
  return pool.size
}
