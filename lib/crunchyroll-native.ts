// ─────────────────────────────────────────────────────────────────────────────
// Native Crunchyroll cookie checker — NO third-party API.
//
// Talks to Crunchyroll's beta-api directly. Community combo checkers
// (BOTCHATTH/CRUNCHYROLL-WEB-CHECKER, sexfrance/Crunchyroll-Account-Checker) log
// in with email:password (password grant); here we authenticate with the browser
// session COOKIE instead — the `etp_rt` refresh-token cookie via the WEB client's
// `etp_rt_cookie` grant — so Crunchyroll plugs into the SAME cookie-checking
// pipeline as the Netflix and Prime checkers. Once a token is obtained, the
// account lookup, profile name, and subscription-benefits steps are identical to
// those references. The exact client/grant/dead-signal were verified live.
//
// Results are ACCURATE and binary, matching the user's rule:
//   • ALIVE = the cookie authenticates AND the account has an ACTIVE premium
//             subscription (Fan / Mega Fan / Ultimate).
//   • DEAD  = anything else, specifically:
//       – invalid / expired / logged-out cookie (token 401)  → "Cookie expired or invalid"
//       – authenticates but NO active subscription (free)     → "No subscription"
//
// There is intentionally NO "status unknown" alive state. Any inconclusive
// network / proxy condition (403 / 429 / 5xx / timeout / interstitial) is reported
// as a RETRY (errorCategory) so the proxy-failover pool hops to a fresh exit IP —
// never a false alive/dead — exactly how the Netflix/Prime checkers behave.
//
// Validation pipeline (mirrors the reference's check flow):
//   1. TOKEN     POST /auth/v1/token  grant_type=etp_rt_cookie  (Cookie: etp_rt=…)
//                via the WEB client (Basic auth) → access_token.
//                400 invalid_grant (or 401) ⇒ dead cookie.
//   2. ME        GET  /accounts/v1/me            → external_id (+ email_verified).
//   3. PROFILE   GET  /accounts/v1/me/multiprofile → username (best-effort "name").
//   4. BENEFITS  GET  /subs/v1/subscriptions/{external_id}/benefits
//                → subscription_country + `concurrent_streams.N` tier. 404 /
//                  not_found / total:0 ⇒ FREE (dead).
//
// Returns the same `CheckResult` shape the UI already consumes.
// ─────────────────────────────────────────────────────────────────────────────
import { Agent, fetch, type Dispatcher } from "undici"
import type { CheckResult } from "./normalize-upstream"
import type { CheckErrorCategory } from "./check-errors"

const TOKEN_URL = "https://beta-api.crunchyroll.com/auth/v1/token"
const ME_URL = "https://beta-api.crunchyroll.com/accounts/v1/me"
const PROFILE_URL = "https://beta-api.crunchyroll.com/accounts/v1/me/multiprofile"
// Benefits is per-account: `${SUBS_BASE}/${externalId}/benefits`.
const SUBS_BASE = "https://beta-api.crunchyroll.com/subs/v1/subscriptions"

// Crunchyroll WEB client credentials, Basic-encoded (`noaihdevm_6iyg0a8l0q:` with
// an empty secret → base64). This is the ONLY public client that supports the
// `etp_rt_cookie` grant — verified live: the SamsungTV/password clients reject it
// with `unsupported_grant_type`, whereas this web client accepts the cookie and
// returns a normal `invalid_grant` for a bad cookie. Sent as an Authorization
// header (the cookie grant uses Basic auth, NOT body client credentials).
const WEB_CLIENT_AUTH = "Basic bm9haWhkZXZtXzZpeWcwYThsMHE6"

// SECURITY — every endpoint the cookie / bearer token is sent to MUST be https://.
// The session cookie (etp_rt) and access token travel in request headers; over
// http:// they would be readable in CLEARTEXT by any proxy hop. Fail LOUDLY at
// module load if a future edit downgrades one to non-https.
for (const [name, url] of Object.entries({ TOKEN_URL, ME_URL, PROFILE_URL, SUBS_BASE })) {
  if (!url.startsWith("https://")) {
    throw new Error(`SECURITY: ${name} must use https:// to protect credentials in transit (got: ${url})`)
  }
}

// SECURITY — host allowlist. A hostile public proxy could redirect us to an
// attacker host serving FAKE JSON to make a dead cookie look alive. (undici strips
// the Authorization/Cookie header on cross-origin redirects, so creds aren't
// leaked — but we must still refuse to TRUST such a response.)
function isCrunchyrollHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== "https:") return false
    const host = hostname.toLowerCase()
    return host === "crunchyroll.com" || host.endsWith(".crunchyroll.com")
  } catch {
    return false
  }
}

// Per-request timeout on the DIRECT path. Crunchyroll's JSON endpoints are small
// and fast, so this is tighter than the Prime HTML timeout.
const REQUEST_TIMEOUT_MS = 12_000
// Per-request timeout through a FREE PROXY. Free proxies are fast or hopeless —
// abandon a slow one aggressively and let the caller hop to a fresh proxy.
export const PROXY_REQUEST_TIMEOUT_MS = 5_000

// Reuse warm sockets to Crunchyroll across checks (avoids TCP+TLS per request).
const crunchyrollAgent = new Agent({
  connections: 48,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  connect: { timeout: 10_000 },
  pipelining: 1,
})

// Desktop browser user-agent. The `etp_rt_cookie` grant is the WEB login flow, so
// we present as a browser (matches the web client we authenticate with) for the
// token call and all subsequent bearer-token API calls.
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0"

export type NativeError = { errorCategory: CheckErrorCategory; retryAfterMs?: number }

// ─── i18n / region helpers ────────────────────────────────────────────────────

// 2-letter subscription_country → human label. Locale-independent so the
// displayed region stays clean English regardless of the account language.
const COUNTRY_LABELS: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  JP: "Japan",
  AU: "Australia",
  IN: "India",
  BR: "Brazil",
  MX: "Mexico",
  NL: "Netherlands",
  SE: "Sweden",
  PL: "Poland",
  PH: "Philippines",
  ID: "Indonesia",
  TH: "Thailand",
  KR: "South Korea",
  TW: "Taiwan",
  HK: "Hong Kong",
}

function countryToRegion(code: string | undefined): { region?: string; countryCode?: string } {
  if (!code) return {}
  const c = code.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(c)) return { region: COUNTRY_LABELS[c] ?? c, countryCode: c }
  return {}
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

// Maps a Crunchyroll HTTP status into our retry-aware error category.
function categorize(status: number): CheckErrorCategory {
  if (status === 429) return "rate_limited"
  if (status === 403 || status === 406) return "upstream_error" // likely an IP block / challenge
  if (status >= 500) return "upstream_unavailable"
  return "upstream_error"
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const seconds = Number(headerValue)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const when = Date.parse(headerValue)
  if (Number.isFinite(when)) return Math.max(0, when - Date.now())
  return undefined
}

type FetchOk = { res: Awaited<ReturnType<typeof fetch>>; text: string }
type FetchErr = { error: NativeError; message: string }

async function crFetch(
  url: string,
  init: {
    method: "GET" | "POST"
    dispatcher: Dispatcher
    timeoutMs: number
    headers?: Record<string, string>
    body?: string
  },
): Promise<FetchOk | FetchErr> {
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Accept: "*/*",
        "Accept-Encoding": "identity",
        ...init.headers,
      },
      body: init.body,
      redirect: "follow",
      dispatcher: init.dispatcher,
      signal: AbortSignal.timeout(init.timeoutMs),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    const category: CheckErrorCategory = isTimeout ? "timeout" : "upstream_unavailable"
    const message = isTimeout ? "Crunchyroll request timed out." : "Could not reach Crunchyroll."
    return { error: { errorCategory: category }, message }
  }

  // SECURITY — refuse to trust a response that didn't end on a real Crunchyroll host.
  if (!isCrunchyrollHost(res.url || url)) {
    await res.text().catch(() => "")
    return {
      error: { errorCategory: "upstream_unavailable" },
      message: "Response did not come from Crunchyroll — will retry.",
    }
  }
  const text = await res.text().catch(() => "")
  return { res, text }
}

// Pulls the first regex capture group from a JSON-ish text body (the reference
// parses with regex too, which is resilient to key ordering).
function grab(text: string, re: RegExp): string | undefined {
  const m = text.match(re)
  return m ? m[1] : undefined
}

// Maps Crunchyroll's `concurrent_streams.N` benefit to a human plan tier (mirrors
// the reference's plan_type mapping). N streams uniquely identify the tier.
function planFromStreams(streams: string | undefined): { plan: string; maxStreams?: number } {
  switch (streams) {
    case "6":
      return { plan: "Ultimate Fan", maxStreams: 6 }
    case "4":
      return { plan: "Mega Fan", maxStreams: 4 }
    case "1":
      return { plan: "Fan", maxStreams: 1 }
    default:
      return { plan: streams ? `Premium (${streams} streams)` : "Premium", maxStreams: streams ? Number(streams) : undefined }
  }
}

// Pure helpers exported for unit testing. Not part of the runtime API.
export const __cr = { isCrunchyrollHost, categorize, planFromStreams, countryToRegion }

export async function checkCrunchyrollCookieNative(
  rawCookie: string,
  opts: { includeRaw: boolean; dispatcher?: Dispatcher; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: NativeError }> {
  if (!rawCookie) {
    return { result: { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" } }
  }

  const dispatcher: Dispatcher = opts.dispatcher ?? crunchyrollAgent
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const anonId = randomId()

  // ── 1. TOKEN — authenticate with the session cookie (etp_rt_cookie grant) ────
  // Web client via Basic auth header + a required device_id in the body. Verified
  // live against beta-api: this is the only client/grant combo that works for a
  // cookie, and a bad cookie comes back as `400 invalid_grant` (NOT 401).
  const tokenBody =
    `grant_type=etp_rt_cookie&scope=offline_access` +
    `&device_id=${anonId}&device_type=Firefox&device_name=Firefox`
  const tokenRes = await crFetch(TOKEN_URL, {
    method: "POST",
    dispatcher,
    timeoutMs,
    headers: {
      Authorization: WEB_CLIENT_AUTH,
      "Content-Type": "application/x-www-form-urlencoded",
      "etp-anonymous-id": anonId,
      Cookie: rawCookie,
    },
    body: tokenBody,
  })
  if ("error" in tokenRes) {
    return { result: { valid: false, message: tokenRes.message, errorCategory: tokenRes.error.errorCategory }, error: tokenRes.error }
  }

  // An invalid / expired / logged-out cookie is authoritatively DEAD. Crunchyroll
  // signals this as `400 invalid_grant` for the cookie grant (and 401 on some
  // edges) — both mean the cookie itself failed, so treat them as a dead verdict.
  if (tokenRes.res.status === 401) {
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }
  if (tokenRes.res.status === 400) {
    if (/invalid_grant|invalid_client/i.test(tokenRes.text)) {
      return { result: { valid: false, message: "Cookie expired or invalid." } }
    }
    // A different 400 (malformed request) is on us, not the cookie → retry rather
    // than emit a false dead.
    return retry("Couldn't verify through this proxy — will retry.")
  }
  // Transient upstream / proxy block → retry on a fresh proxy.
  if (tokenRes.res.status !== 200) {
    return transient(tokenRes.res.status, tokenRes.res.headers.get("retry-after"))
  }
  const accessToken = grab(tokenRes.text, /"access_token"\s*:\s*"([^"]+)"/)
  if (!accessToken) {
    // 200 with no token is an unexpected/blocked response → retry, never a verdict.
    return retry("Couldn't verify through this proxy — will retry.")
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "etp-anonymous-id": randomId(),
  }

  // ── 2. ME — fetch the account's external_id (needed for the benefits lookup) ─
  const meRes = await crFetch(ME_URL, { method: "GET", dispatcher, timeoutMs, headers: authHeaders })
  if ("error" in meRes) {
    return { result: { valid: false, message: meRes.message, errorCategory: meRes.error.errorCategory }, error: meRes.error }
  }
  if (meRes.res.status !== 200) {
    // A forbidden account can't have its subscription verified → treat as DEAD
    // (not a premium hit); other non-200s are transient → retry.
    if (meRes.res.status === 403) {
      return { result: { valid: false, message: "Account is restricted — subscription can't be verified." } }
    }
    return transient(meRes.res.status, meRes.res.headers.get("retry-after"))
  }
  const externalId = grab(meRes.text, /"external_id"\s*:\s*"([^"]+)"/)
  if (!externalId) {
    return retry("Couldn't read the account — will retry.")
  }

  // ── 3. PROFILE — username is the account "name" (best-effort, non-fatal) ─────
  let username: string | undefined
  const profileRes = await crFetch(PROFILE_URL, { method: "GET", dispatcher, timeoutMs, headers: authHeaders })
  if (!("error" in profileRes) && profileRes.res.status === 200) {
    username = grab(profileRes.text, /"username"\s*:\s*"([^"]+)"/)
  }

  // ── 4. BENEFITS — the subscription tier decides ALIVE (premium) vs DEAD (free) ─
  const benefitsRes = await crFetch(`${SUBS_BASE}/${externalId}/benefits`, {
    method: "GET",
    dispatcher,
    timeoutMs,
    headers: authHeaders,
  })
  if ("error" in benefitsRes) {
    return {
      result: { valid: false, message: benefitsRes.message, errorCategory: benefitsRes.error.errorCategory },
      error: benefitsRes.error,
    }
  }
  // The reference treats 200 and 404 as the only conclusive benefit responses;
  // everything else is transient and retried on a fresh proxy.
  if (benefitsRes.res.status !== 200 && benefitsRes.res.status !== 404) {
    return transient(benefitsRes.res.status, benefitsRes.res.headers.get("retry-after"))
  }

  const body = benefitsRes.text
  const subscriptionCountry = grab(body, /"subscription_country"\s*:\s*"([^"]+)"/)

  // ACCURACY — PREMIUM (alive) is proven by an ACTIVE subscription benefit in the
  // payload, and FREE (dead) is decided ONLY on an authoritative empty/not-found
  // signal. The `concurrent_streams.N` benefit is the tier marker; the presence of
  // ANY benefit entry likewise means an active subscription. We deliberately no
  // longer treat a MISSING `subscription_country` as "free": a premium payload can
  // omit that field (or nest it so the flat regex misses it), which previously made
  // working premium accounts read as dead — and flip to alive on recheck.
  const streams = grab(body, /"benefit"\s*:\s*"concurrent_streams\.(\d+)"/)
  const hasBenefit = streams !== undefined || /"benefit"\s*:\s*"[^"]+"/i.test(body)
  const authoritativeEmpty =
    benefitsRes.res.status === 404 ||
    /subscription\.not_found/i.test(body) ||
    /Subscription Not Found/i.test(body) ||
    /"total"\s*:\s*0\b/.test(body) ||
    /"items"\s*:\s*\[\s*\]/.test(body)

  // EXPIRED subscription → DEAD. A benefits payload can still list a subscription
  // whose entitlement window has already ended (a lapsed sub that hasn't yet
  // collapsed to 404/empty). If it carries an end/expiration date and that date is
  // in the PAST, the subscription is no longer active — treat it as dead, never a
  // premium hit. A missing date is NOT treated as expired (active subs commonly
  // omit it), so this only ever fires on a positively-past date.
  const expiryRaw = grab(body, /"(?:expiration_date|expires|end_date|expire_date|current_period_end_date)"\s*:\s*"([^"]+)"/)
  const expiryMs = expiryRaw ? Date.parse(expiryRaw) : NaN
  const isExpired = Number.isFinite(expiryMs) && expiryMs <= Date.now()

  const isFree = authoritativeEmpty || !hasBenefit || isExpired

  const { region, countryCode } = countryToRegion(subscriptionCountry)
  const profiles = username ? [username] : undefined

  if (isFree) {
    // Authenticated but no ACTIVE subscription (free, none, or expired) → DEAD per
    // the "paid only" rule. Both variants use the "No subscription" plan so the
    // reward generator's non-subscription filter purges/skips them uniformly.
    return {
      result: {
        valid: false,
        plan: "No subscription",
        countryCode,
        profiles,
        message: isExpired
          ? "Crunchyroll subscription expired."
          : "Logged in, but no active Crunchyroll subscription.",
        raw: opts.includeRaw
          ? { account: { username, externalId, region, countryCode, premium: false, expired: isExpired } }
          : undefined,
      },
    }
  }

  // PREMIUM → ALIVE. Derive the tier from the concurrent-streams benefit (computed
  // above as part of the premium/free classification).
  const { plan, maxStreams } = planFromStreams(streams)

  const result: CheckResult = {
    valid: true,
    // Stable per-ACCOUNT identity (Crunchyroll's external_id). Crunchyroll never
    // exposes an email, so WITHOUT this the saved-pool dedup fell back to hashing
    // the rotating cookie string — re-checking the same account with a freshly
    // captured cookie stored it AGAIN as a duplicate row. Carrying the external_id
    // here lets saveAliveCrunchyrollCookies dedup on the real account identity.
    accountId: externalId,
    plan,
    countryCode,
    profiles,
    maxStreams,
    message: region ? `Active ${plan} subscription · ${region}` : `Active ${plan} subscription`,
  }
  if (opts.includeRaw) {
    result.raw = { account: { username, externalId, region, countryCode, plan, maxStreams, premium: true } }
  }
  return { result }
}

// A definitive transient upstream verdict (proxy block / rate limit / 5xx) → the
// pool hops to a fresh exit IP instead of trusting it.
function transient(status: number, retryAfter: string | null): { result: CheckResult; error: NativeError } {
  const category = categorize(status)
  const retryAfterMs = parseRetryAfterMs(retryAfter)
  return {
    result: {
      valid: false,
      message: category === "rate_limited" ? "Rate limited by Crunchyroll — backing off." : `Crunchyroll returned ${status}.`,
      errorCategory: category,
      retryAfterMs,
    },
    error: { errorCategory: category, retryAfterMs },
  }
}

// A soft "couldn't confirm" retry (e.g. blocked/empty body) — always retryable so
// the caller never records a false dead/alive.
function retry(message: string): { result: CheckResult; error: NativeError } {
  return {
    result: { valid: false, message, errorCategory: "upstream_unavailable" },
    error: { errorCategory: "upstream_unavailable" },
  }
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `web-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }
}
