// ─────────────────────────────────────────────────────────────────────────────
// Native Amazon Prime Video cookie checker — NO third-party API.
//
// Talks to Amazon directly, mirroring the canonical community checker
// (harshitkamboj/PrimeVideo-Cookie-Checker) so results are ACCURATE and binary:
//
//   • ALIVE = the session is logged in AND has an ACTIVE Prime subscription
//             (POSITIVELY confirmed — a bare logged-in session is NOT enough).
//   • DEAD  = anything else, specifically:
//       – invalid / expired / logged-out cookie  → "Cookie expired or invalid"
//       – logged in but NO active Prime           → "No Prime"
//
// We only call an account ALIVE when Prime membership is POSITIVELY confirmed. Any
// signed-in session whose active Prime can't be confirmed is authoritative DEAD
// ("No Prime") — terminal (never retried, so runs don't freeze on the final rows)
// and deletable (purged from the saved pool on a recheck, never handed out). A
// genuinely inconclusive NETWORK/proxy condition still returns a retryable category
// so it fails over to a fresh exit IP instead of being wrongly killed. This strict
// rule guarantees no-Prime accounts never enter the pool or the rewards.
//
// Validation pipeline (mirrors the reference's get_prime_video_data):
//   1. STOREFRONT  GET https://www.primevideo.com/region/eu/storefront
//      Amazon redirects to the account's real regional storefront. For a LOGGED-IN
//      session this document inlines the `watchlistAction.ajaxEnabled` flag — the
//      reference's authoritative PAID (true) vs no-Prime (false) signal. A DEAD
//      session is bounced to the Amazon sign-in page.
//   2. CONFIG API  GET https://atv-ps.primevideo.com/acm/GetConfiguration/WebClient
//                      ?deviceTypeID=AOAGZA014O5RE&deviceID=Web
//      Returns JSON whose `customerID` is the authoritative login proof (present &
//      non-empty ⇒ authenticated; present & empty ⇒ logged out) and whose
//      `recordTerritory` gives the account region.
//
// Returns the same `CheckResult` shape the UI already consumes.
// ─────────────────────────────────────────────────────────────────────────────
import { Agent, fetch, type Dispatcher } from "undici"
import type { CheckResult } from "./normalize-upstream"
import type { CheckErrorCategory } from "./check-errors"

// The canonical logged-in storefront. Amazon redirects this to the account's real
// region storefront (na/eu/fe), where the Prime membership flag renders server-side.
const STOREFRONT_URL = "https://www.primevideo.com/region/eu/storefront"
// Authoritative authentication surface — the Prime Video WebClient configuration
// API. Returns JSON with the customer id / territory for a live session, and an
// empty customer id (or a sign-in redirect) for a dead one.
const CONFIG_URL =
  "https://atv-ps.primevideo.com/acm/GetConfiguration/WebClient?deviceTypeID=AOAGZA014O5RE&deviceID=Web"
// SECURITY — every endpoint the cookie is sent to MUST be https://. The Amazon
// session cookies (at-main / sess-at-main / session-token …) travel in request
// headers; over http:// they would be readable in CLEARTEXT by any proxy hop.
// Fail LOUDLY at module load if a future edit downgrades one to non-https.
for (const [name, url] of Object.entries({ STOREFRONT_URL, CONFIG_URL })) {
  if (!url.startsWith("https://")) {
    throw new Error(`SECURITY: ${name} must use https:// to protect cookies in transit (got: ${url})`)
  }
}

// SECURITY — host allowlist. A response can follow redirects; a hostile public
// proxy could 302 us to an attacker host serving FAKE config to make a dead
// cookie look alive. (undici strips the Cookie header on cross-origin redirects,
// so the cookie isn't leaked — but we must still refuse to TRUST such a response.)
// We verify the FINAL response URL host is an Amazon / Prime Video property.
function isPrimeHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== "https:") return false
    const host = hostname.toLowerCase()
    return (
      host === "primevideo.com" ||
      host.endsWith(".primevideo.com") ||
      host === "amazon.com" ||
      host.endsWith(".amazon.com") ||
      // Amazon's regional marketplaces (amazon.co.uk, amazon.de, amazon.co.jp…).
      /(^|\.)amazon\.[a-z.]{2,6}$/.test(host)
    )
  } catch {
    return false
  }
}

// Per-request timeout on the DIRECT path. Generous enough for a slow edge node,
// short enough that a hung request fails fast. Amazon's documents are larger than
// Netflix's, so this is slightly higher than the Netflix direct timeout.
const REQUEST_TIMEOUT_MS = 12_000

// Per-request timeout through a FREE PROXY. Free proxies are fast or hopeless —
// abandon a slow one aggressively and let the caller hop to a fresh proxy.
export const PROXY_REQUEST_TIMEOUT_MS = 5_000

// Reuse warm sockets to Amazon across checks (avoids TCP+TLS per request).
const primeAgent = new Agent({
  connections: 48,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  connect: { timeout: 10_000 },
  pipelining: 1,
})

// Realistic desktop-browser headers (Chrome 131, matching the reference checker).
// `Accept-Encoding: identity` asks Amazon not to compress so regex scanning the
// HTML is reliable.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Sec-Fetch-Dest": "document",
}

// Header overrides for the JSON configuration API (Accept JSON + storefront referer).
const CONFIG_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.primevideo.com/region/eu/storefront",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
}

export type NativeError = { errorCategory: CheckErrorCategory; retryAfterMs?: number }

// ─── i18n / region helpers ────────────────────────────────────────────────────

// 2-letter territory / country code → human label. Locale-independent, so this
// keeps the displayed region in clean English regardless of the account language.
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
}

// Amazon marketplace id → 2-letter country code (for the rare storefront-HTML path
// where only the obfuscated marketplace id is present).
const MARKETPLACE_COUNTRY: Record<string, string> = {
  ATVPDKIKX0DER: "US",
  A2EUQ1WTGCTBG2: "CA",
  A1F83G8C2ARO7P: "GB",
  A1PA6795UKMFR9: "DE",
  A13V1IB3VIYZZH: "FR",
  APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES",
  A1VC38T7YXB528: "JP",
  A39IBJ37TRP1C6: "AU",
  A21TJRUUN4KGV: "IN",
  A2Q3Y263D00KWC: "BR",
  A1AM78C64UM0Y8: "MX",
  A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE",
  A1C3SOZRARQ6R3: "PL",
}

// Region group (na/eu/fe) ������ human label, used as a coarse fallback when no precise
// country is available.
const REGION_GROUP_LABELS: Record<string, string> = {
  na: "North America",
  eu: "Europe",
  fe: "Asia Pacific",
}

// Normalizes a 2-letter territory code into a { region label, countryCode } pair.
function territoryToRegion(code: string | undefined): { region?: string; countryCode?: string } {
  if (!code) return {}
  const c = code.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(c)) return { region: COUNTRY_LABELS[c] ?? c, countryCode: c }
  return {}
}

// Extracts the region group from a logged-in storefront URL, e.g.
// ".../region/eu/storefront/..." → "Europe". Returns undefined if not present.
function regionFromUrl(finalUrl: string): string | undefined {
  const m = finalUrl.match(/primevideo\.com\/region\/([a-z]{2})\b/i)
  if (!m) return undefined
  const code = m[1].toLowerCase()
  return REGION_GROUP_LABELS[code] ?? code.toUpperCase()
}

// ─── value normalization (mirrors the reference's has_known_value) ─────────────

function isKnownValue(value: string | undefined): boolean {
  const s = (value ?? "").trim().toLowerCase()
  return Boolean(s) && !["unknown", "none", "null", "n/a", "unrecognised", "unrecognized"].includes(s)
}

// ─── JSON traversal (mirrors find_first_value / find_first_present_value) ──────

// Recursively finds the first value for any of `keys`, tracking PRESENCE separately
// from value — an empty-but-present `customerID` is the reference's "logged out".
function findFirstPresent(obj: unknown, keys: Set<string>): { found: boolean; value: string } {
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = findFirstPresent(item, keys)
        if (r.found) return r
      }
    } else {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (keys.has(k)) return { found: true, value: v == null ? "" : String(v).trim() }
      }
      for (const v of Object.values(obj as Record<string, unknown>)) {
        const r = findFirstPresent(v, keys)
        if (r.found) return r
      }
    }
  }
  return { found: false, value: "" }
}

function findFirstValue(obj: unknown, keys: Set<string>): string | undefined {
  const r = findFirstPresent(obj, keys)
  return r.found && r.value ? r.value : undefined
}

// ─── page classification (proxy false-dead guards) ───────────────────────────

// A flagged / datacenter proxy IP frequently gets served an interstitial (bot
// challenge, captcha, "Robot Check", or an Amazon CAPTCHA wall) instead of the
// real document. Those come back 200 with NO customer signal and NO sign-in
// redirect, so a naive "no data ⇒ dead" rule would misread them as a DEAD cookie.
// They're a PROXY problem to retry, not an expired cookie.
function isBlockedInterstitial(html: string): boolean {
  if (!html) return true // empty body from a proxy is never a trustworthy "dead"
  const h = html.slice(0, 20_000).toLowerCase()
  return (
    h.includes("robot check") ||
    h.includes("captcha") ||
    h.includes("/errors/validatecaptcha") ||
    h.includes("sorry, we just need to make sure you're not a robot") ||
    h.includes("to discuss automated access to amazon data") ||
    h.includes("enter the characters you see below") ||
    h.includes("access denied") ||
    h.includes("request blocked") ||
    h.includes("something went wrong on our end") ||
    (h.includes("cloudfront") && h.includes("error"))
  )
}

// Final-URL test for a signed-out / sign-in bounce (authoritative DEAD when the
// HTML/CONFIG corroborate it).
function isSignInUrl(finalUrl: string): boolean {
  return /\/ap\/signin|\/gp\/sign-?in|\/signin\b|signin=1|nonprimehomepage/i.test(finalUrl)
  }

// ─── authenticated-session signals (mirrors infer_signin_state) ───────────────

// True when the document carries a signal that ONLY exists for an authenticated
// session. Amazon inlines these for a live session and never on the signed-out home.
function hasCustomerSignal(html: string): boolean {
  return (
    /"customerID"\s*:\s*"[A-Z0-9]{6,}"/i.test(html) ||
    /"customerId"\s*:\s*"[A-Z0-9]{6,}"/i.test(html) ||
    /"recordCustomerID"\s*:\s*"[A-Z0-9]{6,}"/i.test(html) ||
    /"isLoggedIn"\s*:\s*true/i.test(html)
  )
}

// Storefront HTML proves a SIGNED-IN session (used to corroborate when the config
// API is momentarily unavailable). Mirrors the reference's positive signed-in cues.
function htmlSignedIn(html: string): boolean {
  return (
    /"watchlistAction"\s*:\s*\{\s*"ajaxEnabled"\s*:\s*(?:true|false|null)/i.test(html) ||
    /data-testid="pv-nav-sign-out"/i.test(html) ||
    /data-testid="active-profile-/i.test(html) ||
    hasCustomerSignal(html)
  )
}

// Storefront HTML is an authoritative SIGN-IN page (mirrors infer_signin_state's
// sign_in_page branch) — a definitive DEAD signal.
function htmlSignInPage(html: string): boolean {
  const hasForm = /\/(?:ap|gp)\/signin|name=["'](?:email|password)["']/i.test(html)
  const hasSignInLink = /data-testid="pv-nav-sign-in"/i.test(html)
  const hasSignInRedirect = /\/auth-redirect\/[^"']*signin=1/i.test(html)
  const inactiveProfile = /data-testid="inactive-profile-placeholder"/i.test(html)
  if (hasForm || (hasSignInLink && hasSignInRedirect)) return true
  if (inactiveProfile && (hasSignInLink || hasSignInRedirect)) return true
  return false
}

// ─── Prime subscription classification (mirrors infer_prime_video_data) ────────
//
// The reference decides PAID vs no-Prime from the storefront's inlined
// `watchlistAction.ajaxEnabled` flag — `true` ONLY for an account with an active
// Prime / Prime Video subscription, `false` for a logged-in account without one.
//
// IMPORTANT — this only returns "free" on a POSITIVE no-Prime signal, and "paid"
// on a positive Prime signal. When NEITHER is present it returns null
// ("indeterminate"). For a session we've already confirmed is signed in, the caller
// treats BOTH "free" and null as authoritative DEAD "No Prime": NOT alive (kept out
// of the pool and rewards) and DELETED on a saved recheck. It is terminal (never
// retried), because the storefront reliably inlines this flag for a logged-in
// account, so the answer won't change on a fresh proxy — retrying only stalled the
// run. Only genuinely inconclusive NETWORK/proxy failures use a retryable category.
//
// ACCURACY — the no-Prime verdict is now drawn ONLY from AUTHORITATIVE, structured
// flags that Amazon emits about the account's own membership state. We intentionally
// DO NOT scan for marketing-copy upsells ("join prime", "get prime", "start free
// trial", "subscribe now", …): Amazon renders those promos on PAID accounts' pages
// too (Prime Gaming, Prime Student, gifting, channel upsells), and which ones appear
// changes per request / region / experiment. Matching them made genuine Prime
// accounts read as "No Prime" intermittently — the exact cause of dead verdicts
// flipping to alive on recheck.
const NO_PRIME_AUTHORITATIVE =
  /"isPrimeMember"\s*:\s*false|"isPrimeVideoMember"\s*:\s*false|"hasPrimeSubscription"\s*:\s*false|"benefitId"\s*:\s*"PRIME_NONE"/i

// AUTHORITATIVE "can't stream" states for an otherwise-active membership. Amazon
// keeps the account signed in (and it may still read as a Prime member) when the
// membership is ON HOLD / PAUSED / SUSPENDED because of a billing problem — but it
// CANNOT stream in that state. Mirrors Netflix's on-hold handling: such an account
// is NOT alive and must never be handed out. We match ONLY structured status flags
// Amazon emits about the account's own membership (never marketing copy), so a
// healthy account is never mislabeled.
const PRIME_MEMBERSHIP_ON_HOLD =
  /"(?:membershipStatus|primeStatus|primeMembershipStatus|benefitStatus|subscriptionStatus)"\s*:\s*"(?:ON[_-]?HOLD|HOLD|SUSPENDED|PAUSED|CANCELL?ED|EXPIRED|PAST[_-]?DUE|PAYMENT[_-]?FAILED)"|"is(?:Prime)?(?:Membership)?OnHold"\s*:\s*true|"isMembershipPaused"\s*:\s*true|"hasBillingProblem"\s*:\s*true/i

function isPrimeOnHold(html: string): boolean {
  return PRIME_MEMBERSHIP_ON_HOLD.test(html)
}

function classifyPaid(html: string): "paid" | "free" | null {
  // PRIMARY authority — the storefront's inlined watchlist flag (reference signal).
  const m = html.match(/"watchlistAction"\s*:\s*\{\s*"ajaxEnabled"\s*:\s*(true|false|null)/i)
  if (m) {
    const v = m[1].toLowerCase()
    if (v === "true") return "paid"
    if (v === "false") return "free"
  }
  // Secondary positive Prime-member signals Amazon inlines for subscribers.
  if (/"isPrimeMember"\s*:\s*true|"isPrimeVideoMember"\s*:\s*true|"hasPrimeSubscription"\s*:\s*true/i.test(html)) {
    return "paid"
  }
  // Only an AUTHORITATIVE structured no-Prime flag yields a "free" (dead) verdict.
  if (NO_PRIME_AUTHORITATIVE.test(html)) return "free"
  return null
}

// ��── configuration-API customer state (mirrors classify_configuration_customer_state)
type CustomerState = "authenticated" | "logged_out" | "unavailable"

function classifyCustomerState(configJson: unknown, configText: string): { state: CustomerState; customerId: string } {
  let { found, value } = findFirstPresent(configJson, new Set(["customerID", "customerId"]))
  if (!found) {
    const m =
      configText.match(/"customerID"\s*:\s*"([^"]*)"/i) ?? configText.match(/"customerId"\s*:\s*"([^"]*)"/i)
    if (m) {
      found = true
      value = m[1].trim()
    }
  }
  if (!found) return { state: "unavailable", customerId: "" }
  if (isKnownValue(value)) return { state: "authenticated", customerId: value }
  return { state: "logged_out", customerId: "" }
}

// Region from the configuration JSON (`recordTerritory`), with a raw-text fallback.
function regionFromConfig(configJson: unknown, configText: string): { region?: string; countryCode?: string } {
  let territory = findFirstValue(configJson, new Set(["recordTerritory"]))
  if (!territory) {
    const m = configText.match(/"recordTerritory"\s*:\s*"([^"]+)"/i)
    if (m) territory = m[1].trim()
  }
  return territoryToRegion(territory)
}

// ─── storefront-HTML account extraction (region + profiles fallback) ───────────

// Best-effort profile name extraction. Amazon inlines the account's viewing
// profiles; we scan known profile-name shapes used by the storefront.
function extractProfiles(html: string): string[] {
  const names: string[] = []
  const patterns = [
    /data-testid="active-profile-([^"]{1,40})"/gi,
    /"profileName"\s*:\s*"([^"]{1,40})"/gi,
    /"(?:displayName|name)"\s*:\s*"([^"]{1,40})"/gi,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && names.length < 8) {
      const name = m[1].trim()
      if (name && !names.includes(name)) names.push(name)
    }
    if (names.length) break
  }
  return names
}

// Region fallback parsed from the storefront HTML when the config API didn't
// provide it (marketplace id or an inline territory/country).
function regionFromHtml(html: string): { region?: string; countryCode?: string } {
  const grab = (pattern: RegExp): string | undefined => {
    const m = html.match(pattern)
    return m ? m[1] : undefined
  }
  const marketplaceId =
    grab(/"marketplaceID"\s*:\s*"([A-Z0-9]{8,})"/i) ??
    grab(/"marketplaceId"\s*:\s*"([A-Z0-9]{8,})"/i) ??
    grab(/"obfuscatedMarketplaceId"\s*:\s*"([A-Z0-9]{8,})"/i)
  if (marketplaceId && MARKETPLACE_COUNTRY[marketplaceId]) {
    return territoryToRegion(MARKETPLACE_COUNTRY[marketplaceId])
  }
  const territory =
    grab(/"recordTerritory"\s*:\s*"([A-Z]{2})"/i) ??
    grab(/"currentTerritory"\s*:\s*"([A-Z]{2})"/i) ??
    grab(/"currentCountry"\s*:\s*"([A-Z]{2})"/i)
  return territoryToRegion(territory)
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

// Maps an Amazon HTTP status into our retry-aware error category.
function categorize(status: number): CheckErrorCategory {
  if (status === 429) return "rate_limited"
  if (status === 403) return "upstream_error" // likely an IP block / challenge
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

async function fetchPrime(
  url: string,
  rawCookie: string,
  dispatcher: Dispatcher,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<{ res: Awaited<ReturnType<typeof fetch>>; html: string } | { error: NativeError; message: string }> {
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, ...extraHeaders, Cookie: rawCookie },
      redirect: "follow",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    const category: CheckErrorCategory = isTimeout ? "timeout" : "upstream_unavailable"
    const message = isTimeout ? "Amazon request timed out." : "Could not reach Amazon."
    return { error: { errorCategory: category }, message }
  }

  const finalUrl = res.url || ""
  // SECURITY — refuse to trust a response that didn't end on a real Amazon host.
  if (!isPrimeHost(finalUrl)) {
    await res.text().catch(() => "")
    return {
      error: { errorCategory: "upstream_unavailable" },
      message: "Response did not come from Amazon — will retry.",
    }
  }
  const html = await res.text().catch(() => "")
  return { res, html }
}

// Pure helpers exported for unit testing. Not part of the runtime API.
export const __classify = {
  isBlockedInterstitial,
  isSignInUrl,
  hasCustomerSignal,
  htmlSignedIn,
  htmlSignInPage,
  regionFromUrl,
  classifyPaid,
  classifyCustomerState,
  regionFromConfig,
}
export const __extract = { extractProfiles, regionFromHtml, territoryToRegion }

export async function checkPrimeCookieNative(
  rawCookie: string,
  opts: {
    includeRaw: boolean
    dispatcher?: Dispatcher
    includeLinks?: boolean
    timeoutMs?: number
    // DISTRIBUTION / CLAIMED-RECHECK liveness mode. When set, a session that is
    // confirmed SIGNED IN is treated as ALIVE without re-demanding the (fragile from
    // our datacenter IP) storefront Prime-membership flag — the pool's active Prime
    // was already proven at INGESTION by the bulk checker. The single & bulk checkers
    // leave this OFF so only positively-confirmed active-Prime accounts enter the pool.
    loginOnly?: boolean
  },
): Promise<{ result: CheckResult; error?: NativeError }> {
  if (!rawCookie) {
    return { result: { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" } }
  }

  const dispatcher: Dispatcher = opts.dispatcher ?? primeAgent
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS

  // ── 1. STOREFRONT ─────────────────────────────────────────────────────────
  const sf = await fetchPrime(STOREFRONT_URL, rawCookie, dispatcher, timeoutMs)
  if ("error" in sf) {
    return { result: { valid: false, message: sf.message, errorCategory: sf.error.errorCategory }, error: sf.error }
  }
  const { res, html } = sf
  const finalUrl = res.url || ""

  // Non-2xx after redirects → Amazon problem / block / rate limit → retry.
  if (!res.ok) {
    const category = categorize(res.status)
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"))
    return {
      result: {
        valid: false,
        message:
          category === "rate_limited" ? "Rate limited by Amazon — backing off." : `Amazon returned ${res.status}.`,
        errorCategory: category,
        retryAfterMs,
      },
      error: { errorCategory: category, retryAfterMs },
    }
  }

  // A proxy interstitial / captcha is NEVER a trustworthy verdict → retry.
  if (isBlockedInterstitial(html)) {
    return {
      result: { valid: false, message: "Couldn't verify through this proxy — will retry.", errorCategory: "upstream_unavailable" },
      error: { errorCategory: "upstream_unavailable" },
    }
  }

  // Storefront bounced to the sign-in page → authoritative DEAD (invalid/expired).
  if (isSignInUrl(finalUrl)) {
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }

  // ── 2. STOREFRONT-FIRST AUTH SIGNALS (PRIMARY authority) ─────────────────────
  // The storefront HTML is the authoritative signed-in signal (mirrors the
  // reference's infer_signin_state): a logged-in session inlines the watchlist
  // flag / sign-out nav / active-profile / customerID, none of which Amazon serves
  // to a logged-out visitor. An authoritative sign-in PAGE is the positive
  // logged-out signal. The cross-domain config API below is ADVISORY ONLY — it can
  // never override a storefront that clearly proves the session is signed in.
  const signedInByHtml = htmlSignedIn(html)
  const signInPageByHtml = htmlSignInPage(html)

  // ── 3. CONFIGURATION API (advisory: region + a corroborating auth hint) ──────
  // Used purely to (a) read the account region and (b) corroborate logged-out when
  // the storefront itself is inconclusive. A failed/blocked/empty config response
  // is IGNORED — it must not turn a signed-in account into a dead one (this was the
  // cause of working accounts being reported dead).
  let configAuthenticated = false
  let configLoggedOut = false
  let configRegion: { region?: string; countryCode?: string } = {}
  // Amazon's authoritative, cookie-independent account id (customerID). Captured here
  // so the ALIVE results below can carry it as `accountId` for stable pool dedup.
  let customerId = ""
  const cfg = await fetchPrime(CONFIG_URL, rawCookie, dispatcher, timeoutMs, CONFIG_HEADERS)
  if (!("error" in cfg)) {
    const cfgUrl = cfg.res.url || ""
    if (isSignInUrl(cfgUrl)) {
      configLoggedOut = true
    } else if (cfg.res.ok) {
      let configJson: unknown = {}
      try {
        configJson = JSON.parse(cfg.html)
      } catch {
        configJson = {}
      }
      const cs = classifyCustomerState(configJson, cfg.html)
      if (cs.state === "authenticated") configAuthenticated = true
      else if (cs.state === "logged_out") configLoggedOut = true
      if (cs.customerId) customerId = cs.customerId
      configRegion = regionFromConfig(configJson, cfg.html)
    }
    // Any non-ok config status (429 / 5xx / etc.) is advisory only → ignored here.
  }

  // ── 4. AUTHENTICATION DECISION (never a false dead) ──────────────────────────
  const signedIn = signedInByHtml || configAuthenticated
  if (!signedIn) {
    // DEAD (invalid/expired) ONLY on a POSITIVE logged-out signal.
    if (signInPageByHtml || configLoggedOut) {
      return { result: { valid: false, message: "Cookie expired or invalid." } }
    }
    // Otherwise we could not positively confirm signed-in OR logged-out → the
    // proxy response is inconclusive → retry, NEVER a false dead.
    return {
      result: { valid: false, message: "Couldn't verify through this proxy — will retry.", errorCategory: "upstream_unavailable" },
      error: { errorCategory: "upstream_unavailable" },
    }
  }

  // ── 5. SIGNED IN: classify the Prime subscription ───────────────────────────
  // The session is confirmed logged in. ALIVE now requires a POSITIVE active-Prime
  // signal — a signed-in account is NOT assumed to have Prime. This is a deliberate
  // policy change: accounts WITHOUT an active Prime subscription must never pass as
  // alive, because alive accounts are what get saved to the pool and handed out in
  // the reward generator. The three outcomes:
  //   • paid          → ALIVE ("Prime" — active subscription positively confirmed)
  //   • free OR null  → DEAD  ("No Prime") — a signed-in session with no CONFIRMED
  //                     active Prime. This is AUTHORITATIVE and terminal: the
  //                     storefront reliably inlines the membership flag for a
  //                     logged-in account, so "not confirmed" means "no active
  //                     Prime", not a flaky fetch. Reported as a plain dead (no
  //                     errorCategory) so that it:
  //                       • never retries → no freeze on the final rows,
  //                       • is never saved to the pool or handed out in rewards, and
  //                       • is DELETED from the saved DB on a recheck (counts dead,
  //                         not "errored/kept").
  const paid = classifyPaid(html)
  const htmlRegion = regionFromHtml(html)
  const region = configRegion.region ?? htmlRegion.region ?? regionFromUrl(finalUrl)
  const countryCode = configRegion.countryCode ?? htmlRegion.countryCode
  const profilesList = extractProfiles(html)
  const profiles = profilesList.length ? profilesList : undefined

  // Fallback: if the config API didn't yield the customerID (e.g. sign-in was proven
  // by the storefront HTML alone), read it from the storefront HTML so the ALIVE
  // result still carries a stable accountId for dedup.
  if (!customerId) {
    const m = html.match(/"customerID"\s*:\s*"([A-Z0-9]{6,})"/i) ?? html.match(/"customerId"\s*:\s*"([A-Z0-9]{6,})"/i)
    if (m) customerId = m[1].trim()
  }
  const accountId = customerId || undefined

  // ── 5a. LOGIN-ONLY liveness (reward distribution + claimed recheck) ──────────
  // The session is confirmed SIGNED IN (reliably, direct from ANY IP, via the config
  // API's customerID above). This account's ACTIVE PRIME was already proven when it
  // entered the pool (bulk checker, proxy-confirmed), so at HAND-OUT we must NOT
  // re-demand the storefront membership flag: from our US datacenter IP Amazon often
  // serves a storefront variant WITHOUT that flag (paid === null), and re-requiring it
  // made the engine skip/delete every good foreign account until the pool read empty
  // ("No streamable account available"). We still honor the TWO authoritative negatives
  // so a genuinely downgraded account is purged — an ON-HOLD membership and a POSITIVE
  // no-Prime flag — and otherwise report ALIVE. This runs DIRECT with NO proxy.
  if (opts.loginOnly) {
    if (isPrimeOnHold(html)) {
      return {
        result: {
          valid: false,
          membershipOnHold: true,
          plan: "On Hold",
          countryCode,
          profiles,
          message: region ? `Prime membership on hold · ${region}` : "Prime membership on hold.",
        },
      }
    }
    if (paid === "free") {
      return {
        result: {
          valid: false,
          plan: "No Prime",
          countryCode,
          profiles,
          message: region
            ? `Logged in, but no active Prime subscription · ${region}`
            : "Logged in, but no active Prime subscription.",
        },
      }
    }
    const result: CheckResult = {
      valid: true,
      accountId,
      plan: "Prime",
      countryCode,
      profiles,
      message: region ? `Active Prime subscription · ${region}` : "Active Prime subscription.",
    }
    if (opts.includeRaw) result.raw = { account: { region, countryCode, profiles, primeStatus: "paid" } }
    return { result }
  }

  // Signed in with a POSITIVE no-Prime flag → authoritative DEAD (safe to purge).
  // Only a structured "no active Prime" signal (classifyPaid === "free") is trusted
  // as terminal here.
  if (paid === "free") {
    const result: CheckResult = {
      valid: false,
      plan: "No Prime",
      countryCode,
      profiles,
      message: region
        ? `Logged in, but no active Prime subscription · ${region}`
        : "Logged in, but no active Prime subscription.",
    }
    if (opts.includeRaw) result.raw = { account: { region, countryCode, profiles, primeStatus: "free" } }
    return { result }
  }

  // Signed in, but the storefront inlined NEITHER a paid NOR a no-Prime flag
  // (classifyPaid === null) → INDETERMINATE, NOT authoritative. Amazon intermittently
  // serves a storefront HTML variant WITHOUT the membership flag to our direct
  // datacenter IP; the OLD code treated this like "No Prime" and returned a plain
  // dead (no errorCategory), which the reward engine purged — silently DELETING
  // genuine paid accounts on hand-out until the pool emptied ("No streamable account
  // available"). Return a retryable/inconclusive result instead: it is SKIPPED for
  // this request and, crucially, NEVER deleted from the pool, and the bulk checker
  // re-confirms it through a residential proxy (where the flag is reliably present).
  if (paid === null) {
    const result: CheckResult = {
      valid: false,
      plan: "Prime (unconfirmed)",
      countryCode,
      profiles,
      errorCategory: "upstream_error",
      message: region
        ? `Couldn't confirm Prime membership — will retry · ${region}`
        : "Couldn't confirm Prime membership — will retry.",
    }
    if (opts.includeRaw) result.raw = { account: { region, countryCode, profiles, primeStatus: "unconfirmed" } }
    return { result }
  }

  // Prime member, but the membership is ON HOLD / PAUSED (billing problem) → it logs
  // in yet CANNOT stream. Mirror Netflix on-hold: mark valid:false + membershipOnHold
  // so it's never saved to the pool and NEVER handed out by the reward generator,
  // while still labelling WHY. Authoritative + terminal (no errorCategory → not retried).
  if (isPrimeOnHold(html)) {
    const result: CheckResult = {
      valid: false,
      membershipOnHold: true,
      plan: "Prime (on hold)",
      countryCode,
      profiles,
      message: region
        ? `Prime membership on hold — can't stream · ${region}`
        : "Prime membership on hold — can't stream.",
    }
    if (opts.includeRaw) result.raw = { account: { region, countryCode, profiles, primeStatus: "on_hold" } }
    return { result }
  }

  // NOTE ON STREAMABILITY vs GEO RE-AUTH — we deliberately do NOT probe an auth-gated
  // Prime Video page here. Amazon forces a step-up password (openid.pape.max_auth_age=0)
  // for ANY session opened from an IP far from the account's home region, so from our
  // US datacenter IP a perfectly good FOREIGN account bounces to /ap/signin exactly like
  // a genuinely stale one — the two are indistinguishable server-side. The user injects
  // the cookie into THEIR OWN browser on THEIR OWN IP (near the account region), where a
  // good session streams without any re-auth. A server-side gate probe therefore only
  // produces false negatives (it emptied the whole pool). Liveness is established by the
  // storefront + config auth signals and the active-Prime / not-on-hold checks above,
  // which are IP-independent (they read the account's own membership flags).

  // Confirmed active, streamable Prime → ALIVE.
  const result: CheckResult = {
    valid: true,
    accountId,
    plan: "Prime",
    countryCode,
    profiles,
    message: region ? `Active Prime subscription · ${region}` : "Active Prime subscription",
  }
  if (opts.includeRaw) result.raw = { account: { region, countryCode, profiles, primeStatus: "paid" } }
  return { result }
}
