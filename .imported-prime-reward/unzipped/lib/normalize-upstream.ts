import type { CheckErrorCategory } from "./check-errors"

// Shared result shape returned by the /api/check route and consumed by the UI.
export type Linkages = {
  pc?: string
  mobile?: string
  tv?: string
}

export type SteamGame = {
  appId: number
  name: string
  /** Total hours on record, when Steam reports it. */
  hoursOnRecord?: number
}

export type CheckResult = {
  valid: boolean
  email?: string
  /**
   * Stable per-ACCOUNT identifier, independent of the (rotating) cookie string.
   * PRIME sets this to Amazon's `customerID`; it's the authoritative identity used
   * to dedup the saved pool so the SAME account re-checked with a different cookie
   * capture is refreshed in place instead of stored again as a duplicate row.
   */
  accountId?: string
  plan?: string
  /** Account carries extra members; kept separate so `plan` stays a clean tier. */
  extraMember?: boolean
  /**
   * Netflix ONLY: the session is valid and logged in (so it counts as ALIVE and
   * stays in the saved pool), but the membership is ON HOLD because Netflix could
   * not process the last payment ("Update your payment information to continue").
   * The account can't stream until billing is fixed, so the reward generator must
   * NEVER hand it to a user — it's flagged here so distribution can skip it while
   * still treating it as a live account everywhere else.
   */
  membershipOnHold?: boolean
  countryCode?: string
  paymentMethod?: string
  nextBillingCycle?: string
  memberSince?: string
  phone?: string
  maxStreams?: number
  emailVerified?: boolean
  profiles?: string[]
  /** Steam: owned games, newest/most-played first. Best-effort enrichment. */
  games?: SteamGame[]
  /** Steam: total owned game count (may exceed games.length if the list is capped). */
  gameCount?: number
  links?: Linkages
  raw?: unknown
  message?: string
  demo?: boolean
  // Structured error category for retry decisions + observability (undefined on success).
  errorCategory?: CheckErrorCategory
  // When the upstream told us HOW LONG to wait (e.g. a 429 Retry-After), this is
  // that hint in ms. Used to size the direct-IP cooldown accurately instead of a
  // fixed guess, so the with/without-proxy loop matches Netflix's real window.
  retryAfterMs?: number
}

// Maps a loose upstream payload into our consistent shape without losing the raw data.
// Upstream key names vary, so all lookups are case/space/underscore-insensitive.
export function normalizeUpstream(input: Record<string, unknown> | null): CheckResult {
  if (!input) return { valid: false, message: "Empty response from upstream." }

  // Some APIs wrap the payload in `data` / `result` / `account`.
  const nested = (input.data ?? input.result ?? input.account) as Record<string, unknown> | undefined
  const data = nested && typeof nested === "object" ? { ...input, ...nested } : input
  const flat = flatten(data)

  const statusText = String(pick(flat, ["status", "result", "state", "message"]) ?? "").toLowerCase()
  const negative = /invalid|dead|expired|fail|error|not\s*work|wrong/.test(statusText)
  const positive = /\bvalid\b|success|alive|working|\blive\b|active|premium|standard|basic/.test(statusText)
  const valid = truthy(flat, ["valid", "success", "alive", "working", "live"]) || (positive && !negative)

  const token = pick(flat, ["nftoken", "token", "authtoken", "logintoken", "netflixtoken"])

  return {
    valid,
    email: pick(flat, ["xmail", "email", "emailaddress", "useremail", "account", "login"]),
    plan: pick(flat, ["xtier", "plan", "tier", "membershipplan", "planname", "localizedplanname", "subscription"]),
    countryCode: pick(flat, ["xloc", "countrycode", "country", "countryofsignup", "region"]),
    paymentMethod: pick(flat, ["xbil", "paymentmethod", "payment", "billingtype", "mop", "paymenttype"]),
    nextBillingCycle: pick(flat, [
      "xren",
      "nextbillingcycle",
      "nextbillingdate",
      "nextbilling",
      "billingdate",
      "renewal",
    ]),
    memberSince: pick(flat, ["xmem", "membersince", "since", "signupdate", "memberdate", "created", "registrationdate"]),
    phone: formatPhone(pick(flat, ["xtel", "phone", "phonenumber", "phoneconnection", "mobile", "msisdn"])),
    maxStreams: pickNum(flat, ["maxstreams", "streams", "maxstreamquality", "simultaneousstreams"]),
    emailVerified: pickBool(flat, ["emailverified", "verified"]),
    profiles: pickProfiles(data, flat),
    links: pickLinks(data, flat, token),
    message: pick(flat, ["message", "msg", "error", "reason", "result", "status"]),
    raw: input,
  }
}

// Prefixes a bare numeric phone with "+" for display.
function formatPhone(value?: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return /^\d{7,}$/.test(trimmed) ? `+${trimmed}` : trimmed
}

// Flattens nested objects into a single map keyed by normalized leaf key names.
function flatten(obj: Record<string, unknown>, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const norm = normKey(key)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, out)
    } else if (!(norm in out)) {
      out[norm] = value
    }
  }
  return out
}

function normKey(k: string): string {
  return k.toLowerCase().replace(/[\s_-]+/g, "")
}

function pick(flat: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = flat[k]
    if (typeof v === "string" && v.trim().length > 0) return v
    if (typeof v === "number") return String(v)
  }
  return undefined
}

function pickNum(flat: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = flat[k]
    if (typeof v === "number") return v
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim())
  }
  return undefined
}

function pickBool(flat: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = flat[k]
    if (typeof v === "boolean") return v
    if (typeof v === "string") {
      const t = v.trim().toLowerCase()
      if (["true", "yes", "1"].includes(t)) return true
      if (["false", "no", "0"].includes(t)) return false
    }
  }
  return undefined
}

function truthy(flat: Record<string, unknown>, keys: string[]): boolean {
  return pickBool(flat, keys) === true
}

function pickProfiles(obj: Record<string, unknown>, flat: Record<string, unknown>): string[] | undefined {
  const raw = obj.profiles ?? obj.users ?? obj.accounts ?? (obj as any).profileNames
  if (Array.isArray(raw)) {
    const names = raw
      .map((p) =>
        typeof p === "string"
          ? p
          : p && typeof p === "object"
            ? String((p as any).name ?? (p as any).profileName ?? "")
            : "",
      )
      .filter((n) => n.length > 0)
    return names.length ? names : undefined
  }
  // The API may return a comma-separated profile string (e.g. x_usr: "Burnok, J, Kids").
  const csv = pick(flat, ["xusr", "profiles", "users", "profilenames"])
  if (csv) {
    const names = csv
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
    if (names.length) return names
  }
  return undefined
}

function pickLinks(obj: Record<string, unknown>, flat: Record<string, unknown>, token?: string): Linkages | undefined {
  const links = (obj.links ?? obj.linkages) as Record<string, unknown> | undefined
  if (links && typeof links === "object") {
    const out: Linkages = {
      pc: typeof links.pc === "string" ? links.pc : undefined,
      mobile: typeof links.mobile === "string" ? links.mobile : undefined,
      tv: typeof links.tv === "string" ? links.tv : undefined,
    }
    if (out.pc || out.mobile || out.tv) return out
  }
  // The API returns ready-made auth URLs as x_l1 (PC), x_l2 (Mobile), x_l3 (TV).
  const direct: Linkages = {
    pc: pick(flat, ["xl1", "pc", "pclink", "l1"]),
    mobile: pick(flat, ["xl2", "mobile", "mobilelink", "l2"]),
    tv: pick(flat, ["xl3", "tv", "tvlink", "l3"]),
  }
  if (direct.pc || direct.mobile || direct.tv) return direct
  // Otherwise build standard Netflix auth links from a token when present.
  if (token) return buildAuthLinks(token)
  return undefined
}

// Builds working Netflix token auth links. The base is `https://netflix.com`
// (NO `www.` — the working reference omits it; the `www.` variant fails to log
// in) and each device uses its OWN path: PC = `/`, Mobile = `/unsupported`,
// TV = `/tv2`. IMPORTANT: the token is used RAW — Netflix's nftoken handler
// expects the verbatim base64 token (with its `+` `/` `=`). Running it through
// encodeURIComponent turns those into `%2B %2F %3D`, which Netflix does NOT
// accept, so the link silently fails.
export function buildAuthLinks(token: string): Linkages {
  const t = token.trim()
  return {
    pc: `https://netflix.com/?nftoken=${t}`,
    mobile: `https://netflix.com/unsupported?nftoken=${t}`,
    tv: `https://netflix.com/tv2?nftoken=${t}`,
  }
}

// Deterministic demo result derived from the cookie so the tool feels real without config.
export function buildDemoResult(cookie: string): CheckResult {
  let hash = 0
  for (let i = 0; i < cookie.length; i++) hash = (hash * 31 + cookie.charCodeAt(i)) >>> 0
  const valid = cookie.length > 24 && hash % 3 !== 0
  if (!valid) {
    return { valid: false, message: "Cookie expired or invalid." }
  }

  const plans = ["PREMIUM", "STANDARD", "BASIC"]
  const countries = ["US", "GB", "CA", "DE", "BR", "PH", "JP"]
  const payments = ["MOBILE_WALLET", "CREDIT_CARD", "PAYPAL", "GIFT_CARD"]
  const months = ["January", "February", "March", "April", "May", "June"]
  const profileNames = ["Burnok", "Christy", "Mango", "Kuya", "Ate"]
  const token = makeToken(hash)
  const since = `${months[hash % months.length]} 20${20 + (hash % 6)}`

  return {
    valid: true,
    email: `user${hash % 9999}@gmail.com`,
    plan: plans[hash % plans.length],
    countryCode: countries[hash % countries.length],
    paymentMethod: payments[hash % payments.length],
    nextBillingCycle: `2026-0${1 + (hash % 9)}-${10 + (hash % 18)}`,
    memberSince: since,
    phone: `+639${String(400000000 + (hash % 99999999)).slice(0, 9)}`,
    maxStreams: [1, 2, 4][hash % 3],
    emailVerified: hash % 2 === 0,
    profiles: profileNames.slice(0, 1 + (hash % 3)),
    links: buildAuthLinks(token),
    message: "Cookie is active.",
  }
}

function makeToken(seed: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let out = ""
  let h = seed >>> 0
  for (let i = 0; i < 48; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    out += chars[h % chars.length]
  }
  return out
}
