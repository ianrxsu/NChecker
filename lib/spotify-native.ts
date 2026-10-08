// ─────────────────────────────────────────────────────────────────────────────
// Native Spotify cookie checker — NO third-party API.
//
// Authenticates with the browser session COOKIE (`sp_dc`, Spotify's long-lived
// web auth cookie) so Spotify plugs into the SAME cookie-checking pipeline as the
// Netflix / Prime / Crunchyroll checkers. The flow mirrors how the Spotify web
// player itself bootstraps a session:
//
//   1. TOKEN   GET https://open.spotify.com/api/token
//                  ?reason=init&productType=web-player&totp=…&totpServer=…&totpVer=N
//              with `Cookie: sp_dc=…` → JSON { accessToken, isAnonymous }.
//              `isAnonymous:true` (or no token) ⇒ the cookie is expired/invalid
//              ⇒ DEAD.
//   2. ME      GET https://api.spotify.com/v1/me  with `Bearer <accessToken>`
//              → { display_name, email, country, product }.
//              `product` is the subscription tier: "premium" (paid, incl.
//              family/duo/student) vs "free"/"open".
//
// Results are ACCURATE and binary, matching the project rule:
//   • ALIVE = the cookie authenticates AND the account is PREMIUM.
//   • DEAD  = invalid/expired cookie, OR authenticates but is a FREE account.
//
// There is intentionally NO "unknown" alive state. Any inconclusive network /
// proxy condition (403 / 429 / 5xx / timeout / HTML challenge) is reported as a
// RETRY (errorCategory) so the proxy-failover pool hops to a fresh exit IP —
// never a false alive/dead — exactly how the other checkers behave.
//
// TOKEN ENDPOINT / TOTP: Spotify RETIRED the old `get_access_token` cookie flow
// (May 2025). The web player now signs the `/api/token` request with an HOTP-style
// one-time code derived from a periodically-ROTATED secret. Hardcoding that secret
// means the checker breaks every time Spotify rotates it, so instead we fetch the
// current secret list at runtime from a community-maintained mirror (cached in the
// warm process, with a hardcoded fallback for when the mirror is unreachable). If
// Spotify rejects the code as expired we drop the cache and refetch — self-healing.
// ─────────────────────────────────────────────────────────────────────────────
import { Agent, fetch, type Dispatcher } from "undici"
import { createHmac } from "node:crypto"
import type { CheckResult } from "./normalize-upstream"
import type { CheckErrorCategory } from "./check-errors"

// New web-player token endpoint (the old get_access_token was retired in 2025).
const TOKEN_ENDPOINT = "https://open.spotify.com/api/token"
const ME_URL = "https://api.spotify.com/v1/me"

// ─── TOTP (HOTP) secret handling ────────────────────────────────────────────
// Community-maintained mirror of Spotify's rotating web-player TOTP secrets, as a
// map of { version: cipherBytes[] }. We use the HIGHEST version present.
const SECRET_DICT_URL =
  "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json"
// Hardcoded fallback (latest known at build time) used only if the mirror can't be
// reached. Kept current-ish; the runtime fetch is the primary, self-updating path.
const FALLBACK_SECRET = {
  version: 61,
  cipher: [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78],
}
const HOTP_PERIOD_S = 30
const HOTP_DIGITS = 6
// Re-fetch the secret list at most once per hour on a warm instance.
const SECRET_TTL_MS = 60 * 60 * 1000

type DerivedSecret = { version: number; key: Buffer }
let cachedSecret: (DerivedSecret & { fetchedAt: number }) | null = null

// Spotify hides the raw HMAC key behind a per-index XOR cipher; this reverses it.
// transformed[i] = cipher[i] XOR ((i mod 33) + 9), then the decimal digits of the
// transformed bytes, concatenated, are the ASCII HMAC key.
function deriveSecretKey(cipher: number[]): Buffer {
  const digits = cipher.map((b, i) => b ^ ((i % 33) + 9)).join("")
  return Buffer.from(digits, "utf8")
}

// Returns the newest available secret, preferring the live mirror and falling back
// to the hardcoded one. Cached for SECRET_TTL_MS on warm instances. `force` skips
// the cache (used to self-heal after Spotify reports the code expired).
async function getSecret(force = false): Promise<DerivedSecret> {
  if (!force && cachedSecret && Date.now() - cachedSecret.fetchedAt < SECRET_TTL_MS) {
    return { version: cachedSecret.version, key: cachedSecret.key }
  }
  try {
    const res = await fetch(SECRET_DICT_URL, { signal: AbortSignal.timeout(8_000) })
    if (res.ok) {
      const dict = (await res.json()) as Record<string, number[]>
      const versions = Object.keys(dict)
        .map(Number)
        .filter((v) => Number.isFinite(v) && Array.isArray(dict[String(v)]))
      if (versions.length > 0) {
        const version = Math.max(...versions)
        const derived = { version, key: deriveSecretKey(dict[String(version)]) }
        cachedSecret = { ...derived, fetchedAt: Date.now() }
        return derived
      }
    }
  } catch {
    // fall through to the hardcoded fallback
  }
  const fallback = { version: FALLBACK_SECRET.version, key: deriveSecretKey(FALLBACK_SECRET.cipher) }
  cachedSecret = { ...fallback, fetchedAt: Date.now() }
  return fallback
}

// Standard HOTP (RFC 4226) over counter = floor(unixSeconds / 30), SHA-1, 6 digits.
// Spotify sends this value as both `totp` and `totpServer`.
function generateHotp(key: Buffer, unixMs: number): string {
  const counter = Math.floor(unixMs / 1000 / HOTP_PERIOD_S)
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac("sha1", key).update(counterBytes).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** HOTP_DIGITS).padStart(HOTP_DIGITS, "0")
}

// Builds the signed token URL for the current secret + clock.
async function buildTokenUrl(force = false): Promise<string> {
  const { version, key } = await getSecret(force)
  const code = generateHotp(key, Date.now())
  const params = new URLSearchParams({
    reason: "init",
    productType: "web-player",
    totp: code,
    totpServer: code,
    totpVer: String(version),
  })
  return `${TOKEN_ENDPOINT}?${params.toString()}`
}

// SECURITY — the cookie / bearer token travel in request headers; over http://
// they'd be readable in cleartext by any proxy hop. Fail LOUDLY at module load if
// a future edit downgrades one to non-https.
for (const [name, url] of Object.entries({ TOKEN_ENDPOINT, ME_URL, SECRET_DICT_URL })) {
  if (!url.startsWith("https://")) {
    throw new Error(`SECURITY: ${name} must use https:// to protect credentials in transit (got: ${url})`)
  }
}

// SECURITY — host allowlist. A hostile public proxy could redirect us to an
// attacker host serving FAKE JSON to make a dead cookie look alive. (undici strips
// the Authorization/Cookie header on cross-origin redirects, so creds aren't
// leaked — but we must still refuse to TRUST such a response.)
function isSpotifyHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== "https:") return false
    const host = hostname.toLowerCase()
    return host === "spotify.com" || host.endsWith(".spotify.com")
  } catch {
    return false
  }
}

const REQUEST_TIMEOUT_MS = 12_000
// Per-request timeout through a FREE PROXY — abandon a slow one aggressively and
// let the caller hop to a fresh proxy.
export const PROXY_REQUEST_TIMEOUT_MS = 5_000

const spotifyAgent = new Agent({
  connections: 48,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  connect: { timeout: 10_000 },
  pipelining: 1,
})

const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

export type NativeError = { errorCategory: CheckErrorCategory; retryAfterMs?: number }

// Spotify's token bootstrap authenticates exclusively with `sp_dc`. Sending an
// entire browser export can include stale analytics/session cookies and duplicate
// names from multiple Spotify subdomains, which makes Spotify's edge classify the
// request as suspicious and return 429 before it even evaluates the account cookie.
// Keep the full export accepted by the UI, but send only the authoritative auth
// cookie to the token endpoint.
function spotifyAuthCookie(rawCookie: string): string {
  const match = rawCookie.match(/(?:^|;\\s*)sp_dc=([^;]*)/i)
  return match?.[1] ? `sp_dc=${match[1]}` : rawCookie.trim()
}

// ─── region helpers ─────────────────────────────────────────────────────────
const COUNTRY_LABELS: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom", DE: "Germany", FR: "France",
  IT: "Italy", ES: "Spain", JP: "Japan", AU: "Australia", IN: "India", BR: "Brazil",
  MX: "Mexico", NL: "Netherlands", SE: "Sweden", PL: "Poland", PH: "Philippines",
  ID: "Indonesia", TH: "Thailand", KR: "South Korea", TW: "Taiwan", HK: "Hong Kong",
  NG: "Nigeria", AR: "Argentina", CL: "Chile", CO: "Colombia", TR: "Turkey",
}
function countryToRegion(code: string | undefined): { region?: string; countryCode?: string } {
  if (!code) return {}
  const c = code.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(c)) return { region: COUNTRY_LABELS[c] ?? c, countryCode: c }
  return {}
}

// Maps Spotify `product` → human plan label. Premium variants all report some
// "premium*" product value; family/duo members report "premium" too.
function planFromProduct(product: string | undefined): { plan: string; premium: boolean } {
  const p = (product ?? "").toLowerCase()
  if (p === "premium" || p.startsWith("premium")) return { plan: "Premium", premium: true }
  if (p === "family" || p === "duo" || p === "student") return { plan: "Premium", premium: true }
  if (p === "free" || p === "open") return { plan: "Free", premium: false }
  return { plan: product ? product : "Free", premium: false }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function categorize(status: number): CheckErrorCategory {
  if (status === 429) return "rate_limited"
  if (status === 403 || status === 406) return "upstream_error"
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

async function spFetch(
  url: string,
  init: { dispatcher: Dispatcher; timeoutMs: number; headers?: Record<string, string>; allowHost: (u: string) => boolean },
): Promise<FetchOk | FetchErr> {
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...init.headers,
      },
      redirect: "follow",
      dispatcher: init.dispatcher,
      signal: AbortSignal.timeout(init.timeoutMs),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    return {
      error: { errorCategory: isTimeout ? "timeout" : "upstream_unavailable" },
      message: isTimeout ? "Spotify request timed out." : "Could not reach Spotify.",
    }
  }
  if (!init.allowHost(res.url || url)) {
    await res.text().catch(() => "")
    return { error: { errorCategory: "upstream_unavailable" }, message: "Response did not come from Spotify — will retry." }
  }
  const text = await res.text().catch(() => "")
  return { res, text }
}

function grab(text: string, re: RegExp): string | undefined {
  const m = text.match(re)
  return m ? m[1] : undefined
}

// api.spotify.com is the data host (distinct from the open.spotify.com auth host).
function isApiSpotifyHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    return protocol === "https:" && hostname.toLowerCase() === "api.spotify.com"
  } catch {
    return false
  }
}

export const __sp = { isSpotifyHost, isApiSpotifyHost, categorize, planFromProduct, countryToRegion, spotifyAuthCookie }

export async function checkSpotifyCookieNative(
  rawCookie: string,
  opts: { includeRaw: boolean; dispatcher?: Dispatcher; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: NativeError }> {
  if (!rawCookie) {
    return { result: { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" } }
  }
  const dispatcher: Dispatcher = opts.dispatcher ?? spotifyAgent
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS

  // ── 1. TOKEN — bootstrap a web access token from the sp_dc cookie ───────────
  // The endpoint requires a TOTP/HOTP code signed with Spotify's rotating secret.
  // We try once; if Spotify says the code/secret version is expired we refetch the
  // latest secret and retry ONCE (self-heal after a rotation).
  let token: string | undefined
  let isAnonymous: boolean | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokenUrl = await buildTokenUrl(attempt > 0)
    const tokenRes = await spFetch(tokenUrl, {
      dispatcher,
      timeoutMs,
      allowHost: isSpotifyHost,
      headers: {
        Cookie: spotifyAuthCookie(rawCookie),
        Referer: "https://open.spotify.com/",
        Origin: "https://open.spotify.com",
        "App-Platform": "WebPlayer",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })
    if ("error" in tokenRes) {
      return { result: { valid: false, message: tokenRes.message, errorCategory: tokenRes.error.errorCategory }, error: tokenRes.error }
    }
    // A rotated/expired TOTP secret comes back as a 400 whose body flags
    // `totpVerExpired` — drop the cache and retry ONCE with a freshly-fetched
    // secret before treating anything as a transient failure.
    if (tokenRes.res.status !== 200) {
      if (attempt === 0 && /totpVerExpired|Unauthorized request/i.test(tokenRes.text)) {
        cachedSecret = null
        continue
      }
      if (tokenRes.res.status === 401 || tokenRes.res.status === 403) {
        // Spotify can serve 401/403 to a flagged proxy IP for a valid cookie → retry
        // rather than emit a false dead.
        return transient(tokenRes.res.status, tokenRes.res.headers.get("retry-after"))
      }
      if (tokenRes.res.status === 429) {
        const retryAfter = tokenRes.res.headers.get("retry-after")
        return {
          result: {
            valid: false,
            message: "Spotify temporarily rate-limited this verification. Wait a moment and retry.",
            errorCategory: "rate_limited",
          },
          error: { errorCategory: "rate_limited", retryAfterMs: parseRetryAfterMs(retryAfter) },
        }
      }
      return transient(tokenRes.res.status, tokenRes.res.headers.get("retry-after"))
    }
    // Expected JSON body. If it isn't JSON (HTML challenge / consent wall) → retry.
    let json: { accessToken?: unknown; isAnonymous?: unknown; totpVerExpired?: unknown; error?: unknown }
    try {
      json = JSON.parse(tokenRes.text)
    } catch {
      return retry("Couldn't read Spotify token response — will retry.")
    }
    // A 200 that still flags an expired TOTP version → drop the cache and retry once.
    if (json.totpVerExpired != null && attempt === 0) {
      cachedSecret = null
      continue
    }
    token = typeof json.accessToken === "string" ? json.accessToken : undefined
    isAnonymous = typeof json.isAnonymous === "boolean" ? json.isAnonymous : undefined
    break
  }
  // An anonymous token means the cookie did NOT authenticate a real user → DEAD.
  if (isAnonymous === true) {
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }
  if (!token) {
    // 200 but no token and not explicitly anonymous → blocked/unexpected → retry.
    return retry("Couldn't verify through this proxy — will retry.")
  }

  // ── 2. ME — read the profile + subscription tier ────────────────────────────
  const meRes = await spFetch(ME_URL, {
    dispatcher,
    timeoutMs,
    allowHost: isApiSpotifyHost,
    headers: { Authorization: `Bearer ${token}` },
  })
  if ("error" in meRes) {
    return { result: { valid: false, message: meRes.message, errorCategory: meRes.error.errorCategory }, error: meRes.error }
  }
  if (meRes.res.status === 401) {
    // Token rejected right after issue → treat the cookie as invalid (DEAD).
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }
  if (meRes.res.status !== 200) {
    return transient(meRes.res.status, meRes.res.headers.get("retry-after"))
  }

  const body = meRes.text
  const email = grab(body, /"email"\s*:\s*"([^"]+)"/)
  const displayName = grab(body, /"display_name"\s*:\s*"([^"]*)"/)
  const country = grab(body, /"country"\s*:\s*"([^"]+)"/)
  const product = grab(body, /"product"\s*:\s*"([^"]+)"/)
  const { region, countryCode } = countryToRegion(country)
  const { plan, premium } = planFromProduct(product)
  const profiles = displayName ? [displayName] : undefined

  if (!premium) {
    // Authenticated but FREE → DEAD per the paid-only rule (mirrors Crunchyroll).
    return {
      result: {
        valid: false,
        plan: "Free",
        email,
        countryCode,
        profiles,
        message: "Logged in, but this is a free Spotify account.",
        raw: opts.includeRaw ? { account: { displayName, email, region, countryCode, product, premium: false } } : undefined,
      },
    }
  }

  const result: CheckResult = {
    valid: true,
    plan,
    email,
    countryCode,
    profiles,
    message: region ? `Active Spotify ${plan} · ${region}` : `Active Spotify ${plan}`,
  }
  if (opts.includeRaw) {
    result.raw = { account: { displayName, email, region, countryCode, plan, product, premium: true } }
  }
  return { result }
}

function transient(status: number, retryAfter: string | null): { result: CheckResult; error: NativeError } {
  const category = categorize(status)
  const retryAfterMs = parseRetryAfterMs(retryAfter)
  return {
    result: {
      valid: false,
      message: category === "rate_limited" ? "Rate limited by Spotify — backing off." : `Spotify returned ${status}.`,
      errorCategory: category,
      retryAfterMs,
    },
    error: { errorCategory: category, retryAfterMs },
  }
}

function retry(message: string): { result: CheckResult; error: NativeError } {
  return {
    result: { valid: false, message, errorCategory: "upstream_unavailable" },
    error: { errorCategory: "upstream_unavailable" },
  }
}
