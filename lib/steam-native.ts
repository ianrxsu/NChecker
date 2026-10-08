// ─────────────────────────────────────────────────────────────────────────────
// Native Steam cookie checker — NO third-party API.
//
// Authenticates with the browser session COOKIE (`steamLoginSecure`, Steam's
// signed web-session token, format `STEAMID||JWT`) so Steam plugs into the SAME
// cookie-checking pipeline as the Netflix / Prime / Crunchyroll / Spotify
// checkers. Unlike the streaming services, Steam has NO subscription tier — an
// account is either signed in or it isn't — so the verdict is liveness-based:
//
//   • ALIVE = the cookie authenticates a real signed-in Steam account.
//   • DEAD  = the cookie is expired / logged out (Steam serves the logged-out
//             store page / redirects to login).
//
// Validation: GET the logged-in store account page and read the per-session JS
// identity Steam injects:
//   GET https://store.steampowered.com/account/  (Cookie: steamLoginSecure=…)
//     → logged in : page contains `g_steamID = "7656119…"` (a 17-digit id) plus
//                    the header `account_name`.
//     → logged out: `g_steamID = false` and a login wall.
//
// There is intentionally NO "unknown" alive state. Any inconclusive network /
// proxy condition (403 / 429 / 5xx / timeout / challenge) is reported as a RETRY
// (errorCategory) so the proxy-failover pool hops to a fresh exit IP — never a
// false alive/dead — exactly how the other checkers behave.
// ─────────────────────────────────────────────────────────────────────────────
import { Agent, fetch, type Dispatcher } from "undici"
import type { CheckResult, SteamGame } from "./normalize-upstream"
import type { CheckErrorCategory } from "./check-errors"

const ACCOUNT_URL = "https://store.steampowered.com/account/"
// Authenticated owned-games feed. With the session cookie attached this returns
// the FULL library as XML even when the profile's game list is private.
const gamesUrl = (steamId: string) => `https://steamcommunity.com/profiles/${steamId}/games/?tab=all&xml=1`

// SECURITY — the session cookie travels in request headers; over http:// it would
// be readable in cleartext by any proxy hop. Fail LOUDLY at module load if a
// future edit downgrades this to non-https.
if (!ACCOUNT_URL.startsWith("https://")) {
  throw new Error(`SECURITY: ACCOUNT_URL must use https:// to protect the session cookie in transit (got: ${ACCOUNT_URL})`)
}

// SECURITY — host allowlist. A hostile public proxy could redirect us to an
// attacker host serving a FAKE logged-in page to make a dead cookie look alive.
// (undici strips the Cookie header on cross-origin redirects, so the credential
// isn't leaked — but we must still refuse to TRUST such a response.)
function isSteamHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== "https:") return false
    const host = hostname.toLowerCase()
    return (
      host === "steampowered.com" ||
      host.endsWith(".steampowered.com") ||
      host === "steamcommunity.com" ||
      host.endsWith(".steamcommunity.com")
    )
  } catch {
    return false
  }
}

const REQUEST_TIMEOUT_MS = 12_000
// Per-request timeout through a FREE PROXY — abandon a slow one aggressively.
export const PROXY_REQUEST_TIMEOUT_MS = 5_000

const steamAgent = new Agent({
  connections: 48,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  connect: { timeout: 10_000 },
  pipelining: 1,
})

const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

export type NativeError = { errorCategory: CheckErrorCategory; retryAfterMs?: number }

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

function grab(text: string, re: RegExp): string | undefined {
  const m = text.match(re)
  return m ? m[1] : undefined
}

// ── Steam token (JWT) inspection ────────────────────────────────────────────
// Steam's web auth uses two tokens, BOTH shaped `STEAMID||<JWT>` (often URL-encoded
// as `STEAMID%7C%7C<JWT>`):
//   • steamLoginSecure  (cookie on *.steampowered.com)  — the ACCESS token. Short
//     lived (~24h). Authenticates page requests directly.
//   • steamRefresh_steam (cookie on login.steampowered.com) — the REFRESH token.
//     Long lived (~200d). A browser uses it to silently mint new access tokens, so
//     a session keeps working in a browser as long as THIS token is unexpired even
//     after the access token died.
// Liveness therefore hinges on the refresh token, not the (usually-expired) access
// token — which is exactly why an access-token-only HTTP check false-flagged real
// accounts as DEAD. We decode the JWT claims LOCALLY (no signature check, no network)
// because Steam IP-binds the refresh token: calling its refresh API from a
// datacenter/proxy IP returns AccessDenied for live accounts, so a network probe
// can't be trusted either.

export type SteamClaims = { steamId?: string; exp?: number; aud?: string[] }

function decodeJwtClaims(jwt: string): SteamClaims | null {
  const parts = jwt.split(".")
  if (parts.length < 2) return null
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    b64 += "=".repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(b64, "base64").toString("utf8")
    const c = JSON.parse(json) as Record<string, unknown>
    const audRaw = c.aud
    return {
      steamId: typeof c.sub === "string" ? c.sub : undefined,
      exp: typeof c.exp === "number" ? c.exp : undefined,
      aud: Array.isArray(audRaw) ? audRaw.filter((a): a is string => typeof a === "string") : undefined,
    }
  } catch {
    return null
  }
}

// Pull one cookie's value out of a RAW `name=value; name=value` header. Values may
// be URL-encoded (the pipeline preserves encoding), so we decode before parsing.
function readCookie(rawCookie: string, name: string): string | undefined {
  // name is a literal known token, but escape defensively.
  const re = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}=([^;]+)`)
  const m = rawCookie.match(re)
  return m ? m[1] : undefined
}

// Parse a `STEAMID||JWT` Steam token cookie into its claims (+ the id from the
// prefix as a fallback when the JWT has no `sub`).
function parseSteamToken(rawCookie: string, cookieName: string): { steamId?: string; exp?: number } | null {
  const raw = readCookie(rawCookie, cookieName)
  if (!raw) return null
  const decoded = decodeURIComponent(raw)
  const sep = decoded.indexOf("||")
  const idPrefix = sep > 0 ? decoded.slice(0, sep) : undefined
  const jwt = sep >= 0 ? decoded.slice(sep + 2) : decoded
  const claims = decodeJwtClaims(jwt)
  if (!claims) return idPrefix ? { steamId: idPrefix } : null
  return { steamId: claims.steamId ?? idPrefix, exp: claims.exp }
}

const VALID_STEAMID_RE = /^\d{17}$/

export const __steam = { isSteamHost, categorize, decodeJwtClaims, parseSteamToken, readCookie }

export async function checkSteamCookieNative(
  rawCookie: string,
  opts: { includeRaw: boolean; dispatcher?: Dispatcher; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: NativeError }> {
  if (!rawCookie) {
    return { result: { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" } }
  }

  // ── PRIMARY VERDICT: access-token validity (local, no network) ────────────
  // A Steam cookie only LOGS IN WHEN IMPORTED (from any IP) while its access token
  // `steamLoginSecure` is unexpired. Steam expires access tokens in ~24h. The
  // long-lived `steamRefresh_steam` token (~200d) can silently re-mint access
  // tokens, BUT it is bound to the original owner's IP (its `ip_subject` claim), so
  // when YOU import the cookie from a different IP Steam refuses to refresh and you
  // stay logged out. Therefore liveness == access token unexpired. A refresh-only
  // cookie is recoverable by the owner on their IP but is NOT importable for us, so
  // it counts as DEAD here. We read the JWT `exp` locally (no network) because
  // Steam's refresh API returns AccessDenied from datacenter/proxy IPs anyway.
  const nowSec = Math.floor(Date.now() / 1000)
  const refresh = parseSteamToken(rawCookie, "steamRefresh_steam")
  const access = parseSteamToken(rawCookie, "steamLoginSecure")

  // small clock-skew grace so a token expiring this very second isn't flapped.
  const SKEW = 60
  const accessAlive = !!access?.exp && access.exp > nowSec - SKEW
  const refreshAlive = !!refresh?.exp && refresh.exp > nowSec - SKEW
  const steamId = [access?.steamId, refresh?.steamId].find((id) => id && VALID_STEAMID_RE.test(id))

  if (!refresh && !access) {
    return { result: { valid: false, message: "No Steam session cookie (steamLoginSecure / steamRefresh_steam) found." } }
  }

  if (!accessAlive) {
    // Access token expired → will NOT log in on import. Distinguish the case where
    // the owner could still recover it (refresh token alive but IP-locked) from a
    // fully-dead session, but both are DEAD for import purposes.
    if (refreshAlive) {
      return {
        result: {
          valid: false,
          message: "Expired login token — not importable (owner could recover it from their own IP).",
        },
      }
    }
    const when = access?.exp ?? refresh?.exp
    const ago = when ? ` (${Math.max(1, Math.round((nowSec - when) / 86400))}d ago)` : ""
    return { result: { valid: false, message: `Steam session expired${ago}.` } }
  }

  // ALIVE — access token is valid, so importing this cookie logs in right now.
  const aliveResult: CheckResult = {
    valid: true,
    plan: "Steam account",
    message: "Active Steam session — imports & logs in.",
    ...(steamId ? { profiles: [steamId] } : {}),
  }
  {
    const hoursLeft = Math.max(1, Math.round((access!.exp! - nowSec) / 3600))
    aliveResult.message = `Active Steam session — logs in on import (~${hoursLeft}h of token validity left).`
  }
  if (opts.includeRaw) {
    aliveResult.raw = {
      account: {
        steamId,
        signedIn: true,
        accessTokenExpiresAt: access?.exp,
        refreshTokenExpiresAt: refresh?.exp,
        verifiedBy: "access_token",
      },
    }
  }

  // ── Best-effort display enrichment ────────────────────────────────────────
  // None of this changes the verdict (already decided above). We resolve the human
  // NAME from Steam's PUBLIC profile (no cookie, reachable from any IP) so the report
  // shows "Wenwolf" instead of the raw 17-digit id, and pull the owned-games library
  // when it's accessible (public profile, or a still-valid access token). Both run
  // concurrently with a tight timeout; any failure just leaves the token-only verdict
  // intact (NAME falls back to the SteamID).
  if (!steamId) return { result: aliveResult }

  const dispatcher: Dispatcher = opts.dispatcher ?? steamAgent
  // Cap enrichment latency so a slow/blocked community response can't drag out a
  // bulk run — the verdict is already known, this is pure decoration.
  const timeoutMs = Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, 8_000)

  const [profile, owned] = await Promise.all([
    fetchPublicProfile(steamId, dispatcher, timeoutMs).catch(() => undefined),
    fetchOwnedGames(steamId, rawCookie, dispatcher, timeoutMs).catch(() => undefined),
  ])

  // NAME hero = persona name when public, else the SteamID (so it's never blank).
  aliveResult.profiles = [profile?.personaName?.trim() || steamId]
  if (profile?.location) aliveResult.countryCode = profile.location
  if (owned) {
    aliveResult.games = owned.games
    aliveResult.gameCount = owned.gameCount
  }
  if (opts.includeRaw && aliveResult.raw && typeof aliveResult.raw === "object") {
    const raw = aliveResult.raw as Record<string, unknown>
    const account = (raw.account ?? {}) as Record<string, unknown>
    account.personaName = profile?.personaName
    account.avatar = profile?.avatar
    account.location = profile?.location
    account.privacy = profile?.privacy
    account.profileUrl = `https://steamcommunity.com/profiles/${steamId}`
    raw.account = account
    if (owned) {
      raw.games = owned.games
      raw.gameCount = owned.gameCount
    }
  }
  return { result: aliveResult }
}

// Legacy live-HTTP probe, retained for reference/diagnostics but no longer the
// verdict path. Kept un-exported and unused by the main flow.
async function _checkSteamCookieViaHttp(
  rawCookie: string,
  opts: { includeRaw: boolean; dispatcher?: Dispatcher; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: NativeError }> {
  const dispatcher: Dispatcher = opts.dispatcher ?? steamAgent
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS

  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(ACCOUNT_URL, {
      method: "GET",
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Cookie: rawCookie,
      },
      redirect: "follow",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    const category: CheckErrorCategory = isTimeout ? "timeout" : "upstream_unavailable"
    return {
      result: {
        valid: false,
        message: isTimeout ? "Steam request timed out." : "Could not reach Steam.",
        errorCategory: category,
      },
      error: { errorCategory: category },
    }
  }

  // SECURITY — refuse to trust a response that didn't end on a real Steam host
  // (e.g. a proxy that redirected us to its own login/captcha host).
  if (!isSteamHost(res.url || ACCOUNT_URL)) {
    await res.text().catch(() => "")
    return retry("Response did not come from Steam — will retry.")
  }
  if (res.status !== 200) {
    return transient(res.status, res.headers.get("retry-after"))
  }

  const html = await res.text().catch(() => "")

  // The per-session identity Steam injects. A 17-digit id ⇒ signed in; `false`
  // (or a login wall) ⇒ logged out. We require the POSITIVE numeric form to call
  // a cookie alive — never the mere ABSENCE of the logged-out marker.
  const steamId = grab(html, /g_steamID\s*=\s*"(\d{17})"/)

  if (!steamId) {
    const loggedOut =
      /g_steamID\s*=\s*false/.test(html) ||
      /<title>[^<]*Sign In[^<]*<\/title>/i.test(html) ||
      /name="username"|login_btn_signin|do_login\(/i.test(html)
    if (loggedOut) {
      // Authoritative logged-out page → the cookie is expired/invalid (DEAD).
      return { result: { valid: false, message: "Cookie expired or invalid." } }
    }
    // 200 but neither a steam id nor a clear login wall → blocked / unexpected
    // markup (challenge, age gate, A/B variant) → retry, never a false verdict.
    return retry("Couldn't confirm the Steam session — will retry.")
  }

  // Signed in → ALIVE. Best-effort display details from the account page.
  const accountName =
    grab(html, /class="account_name"[^>]*>([^<]+)</) ||
    grab(html, /data-miniprofile="[^"]*"[^>]*>\s*([^<]+?)\s*</)
  const walletBalance = grab(html, /id="header_wallet_balance"[^>]*>\s*([^<]+?)\s*</)
  const profiles = accountName ? [accountName.trim()] : undefined

  // Best-effort: pull the owned-games library. This never changes the verdict —
  // an account stays ALIVE even if the games feed is unavailable or empty.
  const owned = await fetchOwnedGames(steamId, rawCookie, dispatcher, timeoutMs)

  const result: CheckResult = {
    valid: true,
    plan: "Steam account",
    profiles,
    message: accountName ? `Signed in as ${accountName.trim()}` : "Signed-in Steam account.",
  }
  if (owned) {
    result.games = owned.games
    result.gameCount = owned.gameCount
  }
  if (opts.includeRaw) {
    result.raw = {
      account: { accountName: accountName?.trim(), steamId, walletBalance, signedIn: true },
      ...(owned ? { games: owned.games, gameCount: owned.gameCount } : {}),
    }
  }
  return { result }
}

// Decodes the handful of XML/HTML entities Steam emits in <name> nodes (titles
// like "Tom Clancy&apos;s …", "Sid Meier&#39;s …", "&amp;").
function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .trim()
}

// Best-effort owned-games fetch. NEVER throws and NEVER affects the alive verdict —
// returns undefined on any failure (private despite auth, proxy hiccup, parse miss).
// Reuses the SAME dispatcher/cookie so it goes through the same proxy exit as the
// liveness check.
async function fetchOwnedGames(
  steamId: string,
  rawCookie: string,
  dispatcher: Dispatcher,
  timeoutMs: number,
): Promise<{ games: SteamGame[]; gameCount: number } | undefined> {
  try {
    const res = await fetch(gamesUrl(steamId), {
      method: "GET",
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Accept: "text/xml,application/xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Cookie: rawCookie,
      },
      redirect: "follow",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Only trust a real Steam host (same anti-redirect guard as the main check).
    if (!isSteamHost(res.url || "") || res.status !== 200) {
      await res.text().catch(() => "")
      return undefined
    }
    const xml = await res.text().catch(() => "")
    const games: SteamGame[] = []
    // Each owned title is a <game> node with <appID>, <name>, optional <hoursOnRecord>.
    const blocks = xml.match(/<game>[\s\S]*?<\/game>/g) ?? []
    for (const block of blocks) {
      const appId = Number(grab(block, /<appID>\s*(\d+)\s*<\/appID>/i))
      const nameRaw = grab(block, /<name>([\s\S]*?)<\/name>/i)
      if (!appId || !nameRaw) continue
      const hoursRaw = grab(block, /<hoursOnRecord>\s*([\d.,]+)\s*<\/hoursOnRecord>/i)
      const hoursOnRecord = hoursRaw ? Number(hoursRaw.replace(/,/g, "")) : undefined
      games.push({
        appId,
        name: decodeXmlEntities(nameRaw),
        ...(Number.isFinite(hoursOnRecord) ? { hoursOnRecord } : {}),
      })
    }
    if (games.length === 0) return undefined
    // Most-played first, then alphabetical — the most useful default ordering.
    games.sort((a, b) => (b.hoursOnRecord ?? 0) - (a.hoursOnRecord ?? 0) || a.name.localeCompare(b.name))
    return { games, gameCount: games.length }
  } catch {
    return undefined
  }
}

// Public Steam community profile (NO cookie, NO auth). steamcommunity.com exposes
// `?xml=1` profile data for any 17-digit SteamID and is reachable from any IP
// (unlike the IP-bound auth endpoints), so this resolves the human-readable persona
// name, avatar and location for an alive account whose access token has expired —
// turning the "NAME = 76561198…" readout into the real account name.
type PublicProfile = {
  personaName?: string
  avatar?: string
  location?: string
  privacy?: string
  online?: string
}
const publicProfileUrl = (steamId: string) => `https://steamcommunity.com/profiles/${steamId}?xml=1`

async function fetchPublicProfile(
  steamId: string,
  dispatcher: Dispatcher,
  timeoutMs: number,
): Promise<PublicProfile | undefined> {
  try {
    const res = await fetch(publicProfileUrl(steamId), {
      method: "GET",
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Accept: "text/xml,application/xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!isSteamHost(res.url || "") || res.status !== 200) {
      await res.text().catch(() => "")
      return undefined
    }
    const xml = await res.text().catch(() => "")
    const cdata = (tag: string) => {
      const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"))
      return m ? decodeXmlEntities(m[1]).trim() : undefined
    }
    const plain = (tag: string) => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))
      return m ? decodeXmlEntities(m[1]).trim() : undefined
    }
    const profile: PublicProfile = {
      personaName: cdata("steamID"),
      avatar: cdata("avatarFull") || cdata("avatarMedium"),
      location: cdata("location") || plain("location"),
      privacy: plain("privacyState"),
      online: plain("onlineState"),
    }
    return profile.personaName || profile.avatar ? profile : undefined
  } catch {
    return undefined
  }
}

function transient(status: number, retryAfter: string | null): { result: CheckResult; error: NativeError } {
  const category = categorize(status)
  const retryAfterMs = parseRetryAfterMs(retryAfter)
  return {
    result: {
      valid: false,
      message: category === "rate_limited" ? "Rate limited by Steam — backing off." : `Steam returned ${status}.`,
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
