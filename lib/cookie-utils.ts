// Shared cookie parsing, conversion, and clipboard utilities used by both the
// single and bulk checkers. All credential handling stays client-side here for
// parsing only; actual verification happens through the server-side API route.

import type { CheckErrorCategory } from "./check-errors"
import { getLiveProxySlice } from "./live-proxies"
import type { ParsedProxy } from "./proxies"

export type CookieFormat = "RAW" | "NETSCAPE" | "JSON"

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
  plan?: string
  /** Whether the account carries extra members. Tracked separately so the
   *  `plan` field stays a clean parent tier (never "Premium (Extra Member)"). */
  extraMember?: boolean
  countryCode?: string
  /** Netflix: regional unavailability, counted as dead for now. */
  regionLocked?: boolean
  paymentMethod?: string
  nextBillingCycle?: string
  memberSince?: string
  phone?: string
  maxStreams?: number
  emailVerified?: boolean
  profiles?: string[]
  /** Steam: owned games, most-played first. Best-effort enrichment. */
  games?: SteamGame[]
  /** Steam: total owned game count (may exceed games.length if the list is capped). */
  gameCount?: number
  links?: Linkages
  /** Netflix only: the account logs in but its last payment failed and it's "on
   *  hold" — counted as DEAD (valid=false) but tagged so the UI can say so. */
  membershipOnHold?: boolean
  message?: string
  demo?: boolean
  raw?: unknown
  errorCategory?: CheckErrorCategory
}

// Canonical English plan tiers. Everything in the UI funnels plans through
// `normalizePlan` so labels, filters, and stats are always English and never
// fragmented by language or an "extra member" suffix.
export const PLAN_TIERS = ["Basic", "Standard", "Premium", "Mobile"] as const

// Normalizes ANY plan string (live result OR legacy stored value from the old
// API era — which may be a foreign name like "DASAR"/"STANDAR" or carry a
// "(Extra Member)" suffix) into a clean canonical English tier. This is the
// single source of truth used across the whole site (checker, filters, admin).
export function normalizePlan(plan?: string | null): string | undefined {
  if (!plan) return undefined
  // Strip any parenthetical extra-member note before matching the tier.
  const base = plan.replace(/\s*\((?:[^)]*member[^)]*|[^)]*extra[^)]*)\)\s*/gi, " ").trim()
  const p = base.toLowerCase()
  if (p.includes("premium")) return "Premium"
  if (
    p.includes("están") || p.includes("estandar") || p.includes("standar") ||
    p.includes("standard") || p.includes("padrão") || p.includes("padrao") || p.includes("standaard")
  ) {
    return "Standard"
  }
  // Mobile inventory is intentionally grouped into Basic in the generator UI.
  if (p.includes("móvil") || p.includes("movil") || p.includes("mobile") || p.includes("celular") || p.includes("ponsel")) {
  return "Basic"
  }
  if (p.includes("básic") || p.includes("basic") || p.includes("básico") || p.includes("básica") || p.includes("dasar")) {
    return "Basic"
  }
  // Unknown/expired markers are preserved (cleaned of the extra-member suffix).
  return base || undefined
}

// SQL ILIKE patterns that (best-effort) match the stored `plan` strings for a
// requested tier. Mirrors the multilingual keyword lists in normalizePlan so a
// bounded DB sample can pre-filter to the requested plan WITHOUT reading the whole
// pool — the JS partitioner still re-validates each sampled row with normalizePlan,
// so any ILIKE false-positive simply falls through to the fallback tier. Returns
// null when no specific plan is requested (or the tier is unknown → match anything),
// meaning "don't constrain the sample by plan".
export function planMatchLikePatterns(plan?: string | null): string[] | null {
  const canonical = normalizePlan(plan)
  if (!canonical) return null
  switch (canonical) {
    case "Premium":
      return ["%premium%"]
    case "Standard":
      return ["%standar%", "%standard%", "%están%", "%padr%", "%standaard%"]
    case "Basic":
      return ["%basic%", "%básic%", "%dasar%", "%mobile%", "%movil%", "%móvil%", "%celular%", "%ponsel%"]
    default:
      // Unknown/legacy tier — bias the sample toward the literal label.
      return [`%${canonical.toLowerCase()}%`]
  }
}

// A cookie is only "alive" when the backend says it's valid AND the plan is not expired.
// An expired plan is treated as dead even if the session itself is technically valid.
export function isPlanExpired(plan?: string): boolean {
  if (!plan) return false
  return /\bexpired?\b|\bcancel(l)?ed\b|\binactive\b/i.test(plan)
}

export function isAliveResult(result: Pick<CheckResult, "valid" | "plan">): boolean {
  return Boolean(result.valid) && !isPlanExpired(result.plan)
}

export type CookieEntry = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  expiry: number
  // Optional attributes that matter for FAITHFUL browser re-import. They're
  // preserved when a source export (Cookie-Editor / EditThisCookie / Puppeteer)
  // provides them, and sensibly defaulted by the exporters when absent. Keeping
  // them optional means RAW/Netscape parsing (which can't know them) is unaffected.
  httpOnly?: boolean
  sameSite?: string
  hostOnly?: boolean
}

export type CookieAnalysis = {
  format: CookieFormat
  total: number
  netflixId: boolean
  secureNetflixId: boolean
  // Amazon Prime auth signals (for the Prime checker's diagnostic bar).
  primeAuth: boolean
  primeSession: boolean
  // Crunchyroll auth signal (the `etp_rt` refresh-token cookie).
  crunchyrollAuth: boolean
}

// Universal clipboard copy that works across desktop AND mobile (Android/iOS)
// webviews. Two strategies, tried in order:
//   1. The async Clipboard API — only in a secure context, and we ALSO require a
//      transient user-activation so Android Chrome doesn't silently reject it.
//   2. A legacy execCommand("copy") fallback tuned for mobile: the textarea must
//      stay ON-SCREEN and non-hidden (Android refuses to copy from display:none /
//      opacity:0 / off-screen nodes), uses a 16px font (prevents iOS auto-zoom),
//      and uses a Range selection on iOS (which ignores textarea.select()).
export async function copyText(text: string): Promise<boolean> {
  if (typeof document === "undefined") return false

  // Strategy 1: async Clipboard API.
  try {
    const hasActivation =
      typeof navigator !== "undefined" &&
      // navigator.userActivation is undefined on older browsers → treat as active.
      (navigator.userActivation ? navigator.userActivation.isActive : true)
    if (navigator?.clipboard?.writeText && window.isSecureContext && hasActivation) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }

  // Strategy 2: execCommand fallback (must keep the element visible & on-screen).
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.width = "1px"
    ta.style.height = "1px"
    ta.style.padding = "0"
    ta.style.border = "none"
    ta.style.outline = "none"
    ta.style.boxShadow = "none"
    ta.style.background = "transparent"
    ta.style.fontSize = "16px" // prevents iOS zoom-on-focus
    document.body.appendChild(ta)

    // Preserve whatever the user had selected so we can restore it afterwards.
    const selection = typeof document.getSelection === "function" ? document.getSelection() : null
    const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
    const isIOS =
      /ipad|iphone|ipod/i.test(ua) ||
      (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

    if (isIOS) {
      // iOS Safari ignores textarea.select(); it needs an explicit Range.
      ta.contentEditable = "true"
      const range = document.createRange()
      range.selectNodeContents(ta)
      selection?.removeAllRanges()
      selection?.addRange(range)
      ta.setSelectionRange(0, text.length)
    } else {
      ta.focus()
      ta.select()
    }

    const ok = document.execCommand("copy")
    document.body.removeChild(ta)

    // Restore the user's previous selection if we clobbered it.
    if (savedRange && selection) {
      selection.removeAllRanges()
      selection.addRange(savedRange)
    }
    return ok
  } catch {
    return false
  }
}

// Locates a JSON cookie array/object embedded anywhere in the text (ignoring surrounding text).
export function findJsonRegion(text: string): { region: string; before: string; after: string } | null {
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start !== -1 && end > start) {
      const region = text.slice(start, end + 1)
      try {
        const parsed = JSON.parse(region)
        if (parsed && (Array.isArray(parsed) || typeof parsed === "object")) {
          return { region, before: text.slice(0, start), after: text.slice(end + 1) }
        }
      } catch {
        // not valid JSON in this region; keep trying
      }
    }
  }
  return null
}

// Reads one parsed JSON cookie object into a normalized entry, tolerating the
// many key spellings real exporters use (Cookie-Editor, EditThisCookie, Puppeteer,
// Playwright, browser devtools): name/Name, value/Value, domain/host/hostKey, etc.
function normalizeJsonCookie(c: any): CookieEntry {
  const domain = c.domain ?? c.hostKey ?? c.host ?? c.domainKey ?? c.Domain ?? ""
  const httpOnly = c.httpOnly ?? c.httponly ?? c.HttpOnly ?? c.isHttpOnly
  const sameSite = c.sameSite ?? c.samesite ?? c.SameSite
  const hostOnly = c.hostOnly ?? c.hostonly ?? c.HostOnly
  return {
    name: String(c.name ?? c.Name ?? ""),
    value: String(c.value ?? c.Value ?? ""),
    domain: String(domain || ".netflix.com"),
    path: String(c.path ?? c.Path ?? "/"),
    secure: Boolean(c.secure ?? c.Secure ?? c.isSecure),
    expiry: Number(c.expirationDate ?? c.expiry ?? c.expires ?? 0) || 0,
    // Preserve the import-fidelity attributes only when the source actually
    // carried them (so we can faithfully round-trip a Cookie-Editor export).
    ...(httpOnly === undefined ? {} : { httpOnly: Boolean(httpOnly) }),
    ...(sameSite === undefined || sameSite === null ? {} : { sameSite: String(sameSite) }),
    ...(hostOnly === undefined ? {} : { hostOnly: Boolean(hostOnly) }),
  }
}

// Extracts EVERY JSON cookie object in `text`, no matter how it's wrapped: a
// single array, several concatenated arrays/objects, NDJSON (one object per
// line), or cookie objects embedded among other text. Walks balanced braces in a
// single linear pass (string- and escape-aware, so `{`/`}` inside values never
// confuse it) and parses each top-level `{…}` independently. O(n) with no regex
// backtracking — safe on huge inputs. Only objects that actually carry a cookie
// name+value are kept, so metadata/config objects are ignored.
export function scanJsonCookieEntries(text: string): CookieEntry[] {
  const out: CookieEntry[] = []
  // Stack of `{` start indices so we can parse balanced objects at ANY depth —
  // this is what lets us pull cookie objects out of a wrapper like
  // `{ url, cookies: [ {…}, {…} ] }`, not just top-level ones.
  const stack: number[] = []
  const seen = new Set<number>()
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === "{") {
      stack.push(i)
    } else if (ch === "}") {
      const start = stack.pop()
      if (start === undefined || seen.has(start)) continue
      const candidate = text.slice(start, i + 1)
      // Cheap guard: only attempt a parse on objects that could be cookies. This
      // skips wrapper/array-noise objects and bounds total parsing cost.
      if (!candidate.includes('"name"') || !candidate.includes('"value"')) continue
      try {
        const obj = JSON.parse(candidate)
        if (obj && typeof obj === "object" && !Array.isArray(obj) && "name" in obj && "value" in obj) {
          out.push(normalizeJsonCookie(obj))
          seen.add(start)
        }
      } catch {
        // incomplete/invalid object — skip it
      }
    }
  }
  return out.filter((c) => c.name && c.value.length > 0)
}

// A single Netscape cookie record: domain, host-only flag, path, secure flag,
// expiry, name, value — separated by ANY run of spaces/tabs. This is deliberately
// tolerant so it matches not just clean tab-separated rows but also dumps where a
// whole account (decorative banner + several cookies) has been flattened onto one
// space-separated line. Names/values are space-free tokens (Netflix cookie values
// are URL-encoded), so a record cannot bleed into the next one.
// NOTE: every quantifier here is BOUNDED. An earlier version used unbounded `*` /
// `+` / `\d+` runs (e.g. `[A-Za-z0-9.\-]*\.[A-Za-z]{2,}`). When scanned globally
// over a huge whitespace-free blob (e.g. a 1 MB single line of digits), the engine
// re-consumes the whole run at every start position and backtracks to find the
// required trailing delimiter — O(n²) catastrophic backtracking that freezes the
// tab. Real Netscape fields are short, so capping each run (domain ≤ 253, epoch ≤
// 19 digits, path/name/value to sane maxima) keeps the scan linear and safe.
const NETSCAPE_RECORD_SOURCE = String.raw`(\.?[A-Za-z0-9][A-Za-z0-9.\-]{0,252}\.[A-Za-z]{2,24})[ \t]+(?:TRUE|FALSE)[ \t]+(\/[^\s]{0,4096})[ \t]+(TRUE|FALSE)[ \t]+(\d{1,19})[ \t]+([^\s]{1,256})[ \t]+([^\s]{1,8192})`

// Extracts every Netscape cookie record found anywhere in the text, regardless of
// whether records are tab-separated, space-separated, or mashed onto one line with
// surrounding noise (banners, dates, labels). Order is preserved.
export function scanNetscapeRecords(text: string): CookieEntry[] {
  // Cheap linear guard: a Netscape record ALWAYS contains a TRUE/FALSE flag. If the
  // text has neither, there's nothing to find — skip the regex entirely so we never
  // run it across large cookie-less blobs.
  if (!/TRUE|FALSE/i.test(text)) return []
  const re = new RegExp(NETSCAPE_RECORD_SOURCE, "gi")
  const out: CookieEntry[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      domain: m[1],
      path: m[2],
      secure: m[3].toUpperCase() === "TRUE",
      expiry: Number(m[4]) || 0,
      name: m[5],
      value: m[6],
    })
  }
  return out
}

// Cheap presence check used by format detection (non-global so it can't carry
// a stale lastIndex between calls).
function hasNetscapeRecord(text: string): boolean {
  return new RegExp(NETSCAPE_RECORD_SOURCE, "i").test(text)
}

// Removes transport-only wrappers commonly added by clipboard tools while leaving
// cookie values untouched. Format detection and parsing then handle the normalized text.
export function normalizeCookieInput(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json|txt|text)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim()
}

// Detects the cookie format from possibly-mixed pasted text (cookies surrounded by other text).
export function detectFormat(text: string): CookieFormat {
  const trimmed = text.trim()
  if (!trimmed) return "RAW"
  if (findJsonRegion(trimmed)) return "JSON"
  // NDJSON / multiple concatenated JSON objects that findJsonRegion can't parse
  // as one region. Cheap substring gate first so we don't scan non-JSON text.
  if (trimmed.includes('"name"') && trimmed.includes('"value"') && scanJsonCookieEntries(trimmed).length > 0) {
    return "JSON"
  }
  if (text.split("\n").some((l) => l.split("\t").length >= 6)) return "NETSCAPE"
  // Also catch space-separated / flattened Netscape dumps that contain no tabs.
  if (hasNetscapeRecord(text)) return "NETSCAPE"
  return "RAW"
}

// Returns true if a single line carries one or more cookie pairs in the given format.
export function lineHasCookies(line: string, format: CookieFormat): boolean {
  const t = line.trim()
  if (!t || t.startsWith("#") || t.startsWith("//")) return false
  if (format === "NETSCAPE") return t.split("\t").length >= 6
  // RAW: a "name=value" token whose name has no spaces (account-detail lines use ": " instead).
  return /[A-Za-z0-9_.!%-]+=[^=\s]/.test(t)
}

// Parses a cookie string (any supported format) into a normalized list of entries.
export function parseCookies(text: string, format: CookieFormat): CookieEntry[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  if (format === "JSON") {
    // Scanner-FIRST: the balanced-brace scan finds every real cookie object no
    // matter how it's wrapped — a flat array, NDJSON, several concatenated
    // arrays/objects, OR cookie objects nested inside a wrapper like
    // `{ url, cookies: [ … ] }`. This is strictly more capable than a single
    // JSON.parse of the whole blob (which would mistake a wrapper's top-level
    // keys for cookies), so we try it before anything else.
    const scanned = scanJsonCookieEntries(trimmed)
    if (scanned.length > 0) return scanned

    // Fallback only for the `{ "name": "value", … }` MAP form, which carries no
    // `{name,value}` objects for the scanner to find.
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed)
          .map(([name, value]) => normalizeJsonCookie({ name, value }))
          .filter((c) => c.name)
      }
    } catch {
      // not parseable as a single JSON value
    }
    return []
  }

  if (format === "NETSCAPE") {
    return trimmed
      .split("\n")
      // Strip only a trailing CR (CRLF files) — NOT a full trim. Trimming the whole
      // line would eat a LEADING tab, which represents an empty domain column and,
      // once gone, shifts every remaining field left by one (domain⇐flag, name⇐value).
      // Splitting on the tab first preserves that empty leading field.
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"))
      .map((line) => {
        const p = line.split("\t")
        return {
          // Field-level trim (not line-level) keeps columns aligned. An empty domain
          // falls back to the placeholder so the entry stays usable and valid.
          domain: (p[0] ?? "").trim() || ".netflix.com",
          path: (p[2] ?? "").trim() || "/",
          secure: (p[3] ?? "").trim().toUpperCase() === "TRUE",
          expiry: Number((p[4] ?? "").trim()) || 0,
          name: (p[5] ?? "").trim(),
          value: p[6] ?? "",
        }
      })
      .filter((c) => c.name)
  }

  // RAW: "name=value; name2=value2" (also tolerate newline-separated pairs)
  return trimmed
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((pair) => {
      const idx = pair.indexOf("=")
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        // RAW headers carry no domain. Leave it empty ("unknown") rather than
        // guessing ".netflix.com" — that guess made every RAW cookie look like it
        // belonged to Netflix, which both leaked cross-service in the checker and
        // stamped Prime/Crunchyroll cookies with ".netflix.com". Callers that need a
        // concrete domain (cookieToNetscape) fill in the correct service domain.
        domain: "",
        path: "/",
        secure: /^Secure/i.test(pair.slice(0, idx).trim()),
        expiry: 0,
      }
    })
}

// Serializes normalized entries back into the requested format.
//
// `defaultDomain` is used for entries that carry NO domain — RAW `name=value`
// pastes never have one. This matters because an empty domain can't be represented
// safely in NETSCAPE (the first column would be blank, producing a line that starts
// with a tab) or usefully in JSON. Callers that know the service pass its login
// domain (e.g. `.amazon.com`) so a RAW→NETSCAPE/JSON conversion stays correct;
// everyone else gets the historical ".netflix.com" placeholder.
export function serializeCookies(
  entries: CookieEntry[],
  format: CookieFormat,
  defaultDomain = ".netflix.com",
): string {
  if (entries.length === 0) return ""
  if (format === "RAW") {
    return entries.map((c) => `${c.name}=${c.value}`).join("; ")
  }
  if (format === "NETSCAPE") {
    return entries
      .map((c) => {
        // A domainless cookie (RAW paste) would otherwise emit an EMPTY first
        // column — a record that begins with a tab. That line is not valid Netscape
        // AND re-parses into SHIFTED columns (the include-subdomains flag is read as
        // the domain, the name as the value, …). That column shift is exactly what
        // broke the RAW→NETSCAPE→JSON→NETSCAPE round trip. Guaranteeing a non-empty
        // domain keeps every record well-formed and losslessly round-trippable.
        const domain = c.domain || defaultDomain
        // Column 2 is the "include subdomains" flag. Per the Netscape cookies.txt
        // spec it MUST be TRUE only when the domain is dot-prefixed (applies to
        // subdomains) and FALSE for a host-only domain. Hardcoding TRUE made
        // host-only cookies import incorrectly (or get rejected by strict parsers).
        const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE"
        // Path and expiry also get safe defaults so all 7 tab-separated columns are
        // always present and correctly aligned.
        const path = c.path || "/"
        const expiry = Number.isFinite(c.expiry) ? c.expiry : 0
        return `${domain}\t${includeSub}\t${path}\t${c.secure ? "TRUE" : "FALSE"}\t${expiry}\t${c.name}\t${c.value}`
      })
      .join("\n")
  }
  // JSON — emit the full Cookie-Editor / EditThisCookie shape so the result
  // imports cleanly in any browser extension (not just name/value/domain).
  return JSON.stringify(entries.map((c) => toCookieEditorObject(c, defaultDomain)), null, 2)
}

// The exact set of sameSite values the browser cookie API / Cookie-Editor accept.
// Anything else (e.g. a stray "None", "" or numeric from a legacy dump) makes the
// extension reject the cookie, so we coerce to a safe, valid value.
const VALID_SAME_SITE = new Set(["no_restriction", "lax", "strict", "unspecified"])
function normalizeSameSite(value: unknown): "no_restriction" | "lax" | "strict" | "unspecified" {
  const v = String(value ?? "").toLowerCase().trim()
  if (v === "none") return "no_restriction"
  if (VALID_SAME_SITE.has(v)) return v as "no_restriction" | "lax" | "strict" | "unspecified"
  return "no_restriction"
}

// Maps a normalized entry to the EXACT object shape browser cookie extensions
// (Cookie-Editor / EditThisCookie) expect, tuned for guaranteed cross-browser
// import. `hostOnly`/`session` are DERIVED from the domain and expiry, `sameSite`
// is coerced to a valid enum, and `expirationDate` is always an integer number of
// seconds so `chrome.cookies.set` never rejects it.
function toCookieEditorObject(c: CookieEntry, defaultDomain = ".netflix.com"): Record<string, unknown> {
  // Domainless RAW cookies get the caller's default so the exported object is
  // importable (a blank domain is rejected by Cookie-Editor / the browser).
  const domain = c.domain || defaultDomain
  const hostOnly = c.hostOnly ?? !domain.startsWith(".")
  const isSession = !c.expiry || c.expiry <= 0
  const sameSite = normalizeSameSite(c.sameSite)
  // Chrome REJECTS a cookie with sameSite "no_restriction" unless Secure is set, so
  // force Secure on for cross-site cookies (streaming auth cookies are Secure anyway).
  const secure = sameSite === "no_restriction" ? true : c.secure ?? true
  return {
    name: String(c.name ?? ""),
    value: String(c.value ?? ""),
    domain,
    hostOnly,
    path: c.path || "/",
    secure,
    httpOnly: c.httpOnly ?? false,
    sameSite,
    session: isSession,
    // Cookie-Editor treats a missing expirationDate as a session cookie; only
    // include it (as integer seconds) for persistent cookies.
    ...(isSession ? {} : { expirationDate: normalizeExpirySeconds(c.expiry) }),
    // NOTE: we intentionally OMIT `storeId`. It's a browser/profile-specific handle;
    // a null or foreign storeId makes `chrome.cookies.set` throw and can abort the
    // whole import. Cookie-Editor fills it in per-browser, so leaving it out is the
    // most portable, import-safe choice.
  }
}

// Splits pasted text into actual cookie entries plus any preserved non-cookie text.
export function splitCookiesAndText(text: string, format: CookieFormat): { entries: CookieEntry[]; extra: string } {
  if (!text.trim()) return { entries: [], extra: "" }

  if (format === "JSON") {
    // parseCookies is scanner-first, so this already covers flat arrays, NDJSON,
    // concatenated arrays/objects, wrapper objects, and the map form.
    const entries = parseCookies(text, "JSON")
    // When the cookies sit in a single JSON region, preserve any text around it
    // as `extra` (notes/labels). NDJSON / concatenated shapes have no single
    // region, so there's nothing meaningful to preserve once cookies are found.
    const region = findJsonRegion(text)
    const extra = region
      ? [region.before, region.after].join("\n").split("\n").filter((l) => l.trim().length > 0).join("\n")
      : entries.length > 0
        ? ""
        : text.trim()
    return { entries, extra }
  }

  // NETSCAPE: scan for records (handles tab, space, and mashed/multi-record lines).
  // The scanner supersedes naive tab-splitting so a flattened account still parses.
  if (format === "NETSCAPE") {
    const entries = scanNetscapeRecords(text)
    if (entries.length > 0) {
      const extra = text
        .replace(new RegExp(NETSCAPE_RECORD_SOURCE, "gi"), "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n")
      return { entries, extra }
    }
    // No records detected; fall through to the generic line-based handling.
  }

  const cookieLines: string[] = []
  const textLines: string[] = []
  for (const line of text.split("\n")) {
    if (lineHasCookies(line, format)) cookieLines.push(line)
    else if (line.trim().length > 0) textLines.push(line)
  }
  const entries = cookieLines.length > 0 ? parseCookies(cookieLines.join("\n"), format) : []
  return { entries, extra: textLines.join("\n") }
}

export function analyzeCookie(text: string): CookieAnalysis {
  if (!text.trim()) {
    return {
      format: "RAW",
      total: 0,
      netflixId: false,
      secureNetflixId: false,
      primeAuth: false,
      primeSession: false,
      crunchyrollAuth: false,
    }
  }
  const format = detectFormat(text)
  const { entries } = splitCookiesAndText(text, format)
  return {
    format,
    total: entries.length,
    netflixId: entries.some((e) => /^NetflixId$/i.test(e.name)),
    secureNetflixId: entries.some((e) => /^SecureNetflixId$/i.test(e.name)),
    primeAuth: entries.some((e) => PRIME_AUTH_RE.test(e.name)),
    primeSession: entries.some((e) => /^session-id$/i.test(e.name)),
    crunchyrollAuth: entries.some((e) => CRUNCHYROLL_AUTH_RE.test(e.name)),
  }
}

// Auto-detect which streaming service a pasted cookie belongs to, using the same
// signature cookies the diagnostics bar keys off. Returns null when no known
// service signal is present (so the smart checker can ask the user to pick one).
// The three services use disjoint auth cookies, so detection is unambiguous:
//   • Netflix     → NetflixId / SecureNetflixId
//   • Prime       → at-main (or session-id)
//   • Crunchyroll → etp_rt
// `allowed` optionally restricts detection to admin-enabled services, so a hidden
// service is never auto-selected on the public smart checker.
export function detectService(
  text: string,
  allowed?: readonly ("netflix" | "prime" | "crunchyroll")[],
): "netflix" | "prime" | "crunchyroll" | null {
  const a = analyzeCookie(text)
  const ok = (svc: "netflix" | "prime" | "crunchyroll") => !allowed || allowed.includes(svc)
  // Crunchyroll first — its etp_rt token is the most distinctive and never overlaps.
  if (a.crunchyrollAuth && ok("crunchyroll")) return "crunchyroll"
  if ((a.netflixId || a.secureNetflixId) && ok("netflix")) return "netflix"
  if ((a.primeAuth || a.primeSession) && ok("prime")) return "prime"
  return null
}

// Reduces a parsed cookie set to the clean RAW header string that the API expects.
// Prefers the service-specific auth cookies (Netflix or Amazon) when present so the
// request header is as clean as possible; falls back to ALL parsed cookies otherwise.
//
// ACCURACY — `service` selects how aggressively we trim:
//   • prime       → send the FULL Amazon session set (domain-scoped). Amazon's
//                   storefront + GetConfiguration endpoints authenticate most
//                   reliably with the WHOLE cookie (the reference checker sends the
//                   entire cookie). Trimming Prime to just the auth slice
//                   (at-main/sess-at-main/x-main/ubid-main) drops the supporting
//                   session cookies (session-id, session-token, lc-main, i18n-prefs)
//                   that Amazon expects — a partial session reads as inconclusive
//                   (false retry) or logged-out (false dead). This is exactly why
//                   single checks (which send the full cookie) were more accurate
//                   than bulk checks (which sent the slice).
//   • crunchyroll → the `etp_rt_cookie` grant needs ONLY the `etp_rt` refresh-token
//                   cookie (verified live), so the lean slice is both correct and
//                   cleanest.
//   • netflix     → NetflixId + SecureNetflixId IS the complete working session, so
//                   the auth slice is sufficient.
//   • undefined   → service unknown: auto-detect by whichever auth slice matches.
// Collapses duplicate cookie NAMES (the same name set on several subdomains) down
// to one entry per name, keeping the variant whose domain best applies to the host
// the checker will request. This is what makes a multi-subdomain Steam/Spotify
// export authenticate: it guarantees the request header carries the ONE correct
// audience-scoped token instead of several conflicting same-named cookies.
function dedupeCookiesForHost(entries: CookieEntry[], targetHost: string, altHosts: string[] = []): CookieEntry[] {
  const host = targetHost.toLowerCase()
  const alts = altHosts.map((h) => h.toLowerCase())
  // Higher score = better fit for the target host.
  const score = (e: CookieEntry): number => {
    const d = (e.domain || "").replace(/^\./, "").toLowerCase()
    if (!d) return 1 // domainless (RAW paste) — usable, lowest priority
    if (d === host) return 4 // exact host (e.g. store.steampowered.com)
    if (host.endsWith(`.${d}`)) return 3 // parent domain (.steampowered.com applies to store.*)
    if (d.endsWith(`.${host}`)) return 2 // a subdomain of the target
    // Alt-host match: treat as score 3 (same tier as parent-domain match). Used for Prime
    // where the cookie may be scoped to .amazon.com but the request goes to primevideo.com —
    // both are equally valid Prime session domains.
    if (alts.some((a) => d === a || a.endsWith(`.${d}`) || d.endsWith(`.${a}`))) return 3
    return 1 // sibling subdomain (checkout/help/community) — least preferred
  }
  // Pick the best-scoring entry for each cookie name (cookie names are case-sensitive).
  const best = new Map<string, CookieEntry>()
  for (const e of entries) {
    const cur = best.get(e.name)
    if (!cur || score(e) > score(cur)) best.set(e.name, e)
  }
  // Emit one entry per name, preserving first-seen order for determinism.
  const seen = new Set<string>()
  const out: CookieEntry[] = []
  for (const e of entries) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push(best.get(e.name)!)
  }
  return out
}

// The host each native checker actually requests with the prepared cookie header.
// Used so dedupeCookiesForHost keeps the variant of a duplicated cookie name whose
// domain best applies to that host — correct for every service, not just Steam.
const CHECK_TARGET_HOST: Record<CheckService, string> = {
  netflix: "www.netflix.com",
  // Prime's first request hits www.primevideo.com (the regional storefront redirect).
  // Using that as the dedup target means primevideo.com-scoped cookies score correctly
  // when a cookie set is exported from Prime Video instead of amazon.com — both domains
  // are valid Prime session hosts. amazon.com-scoped cookies also score correctly
  // because amazon.com is a parent of www.amazon.com and still beats an unrelated host.
  prime: "www.primevideo.com",
  crunchyroll: "www.crunchyroll.com",
  steam: "store.steampowered.com",
  spotify: "open.spotify.com",
}

export function prepareCookieForCheck(
  text: string,
  service?: CheckService,
): { cookie: string; count: number } {
  const fmt = detectFormat(text)
  const allEntries = splitCookiesAndText(text, fmt).entries
  if (allEntries.length === 0) return { cookie: "", count: 0 }

  // PRIME: send the full, domain-scoped Amazon session (most accurate). Fall back to
  // the auth slice only if domain-scoping yields nothing usable.
  if (service === "prime") {
    const scoped = restrictEntriesToService(allEntries, "prime")
    const keep = scoped.length > 0 ? scoped : allEntries.filter((e) => PRIME_AUTH_RE.test(e.name))
    const use = keep.length > 0 ? keep : allEntries
    // Dedupe duplicate names: Amazon sets at-main / ubid-main / session-id across
    // several regional hosts (amazon.com, amazon.co.uk, primevideo.com, …), so a
    // multi-domain export would otherwise emit the same name several times in one header.
    // altHosts: treat amazon.com-scoped cookies as equally preferred to primevideo.com
    // ones so a mixed export (some from amazon.com, some from primevideo.com) keeps the
    // best cookie from either domain — not just the primevideo.com one. Both are valid
    // Prime session domains and the checker hits both surfaces.
    return {
      cookie: serializeCookies(
        dedupeCookiesForHost(use, CHECK_TARGET_HOST.prime, ["www.amazon.com", "amazon.com"]),
        "RAW",
      ),
      count: allEntries.length,
    }
  }

  // STEAM / SPOTIFY: like Prime, send the full domain-scoped session. The Steam
  // account page expects the supporting session cookies (sessionid, steamCountry)
  // alongside steamLoginSecure, and Spotify's token bootstrap is happiest with the
  // whole open.spotify.com set. Fall back to the lone auth cookie, then everything.
  //
  // CRITICAL: a real Steam export carries the SAME cookie name (steamLoginSecure,
  // sessionid, steamCountry) once PER subdomain — checkout/help/steam.tv/community/
  // store — each steamLoginSecure being a DIFFERENT audience-scoped JWT for the same
  // SteamID. Concatenating them all into one header sends duplicate cookie names, and
  // the server keeps only the first — which may be the `web:checkout` token, NOT the
  // `web:store` one the account page needs, so a live account reads as logged-out.
  // We dedupe by name, keeping the variant whose domain best matches the host the
  // checker actually requests (store.steampowered.com / open.spotify.com).
  if (service === "steam" || service === "spotify") {
    const scoped = restrictEntriesToService(allEntries, service)
    const authRe = service === "steam" ? STEAM_AUTH_RE : SPOTIFY_AUTH_RE
    const keep = scoped.length > 0 ? scoped : allEntries.filter((e) => authRe.test(e.name))
    const use = keep.length > 0 ? keep : allEntries
    return { cookie: serializeCookies(dedupeCookiesForHost(use, CHECK_TARGET_HOST[service]), "RAW"), count: allEntries.length }
  }

  // For Amazon Prime sets the Netflix filter would strip everything and return an
  // empty cookie — use whichever auth filter matches the set.
  const netflixAuth = allEntries.filter((e) => NETFLIX_AUTH_RE.test(e.name))
  const primeAuth = allEntries.filter((e) => PRIME_AUTH_RE.test(e.name))
  // Crunchyroll's token grant only needs the `etp_rt` refresh-token cookie, so a
  // clean set sends just that when present.
  const crunchyrollAuth = allEntries.filter((e) => CRUNCHYROLL_AUTH_RE.test(e.name))
  // When the service is known, prefer that service's slice directly so a mixed paste
  // never sends the wrong service's auth cookie.
  const named =
    service === "netflix"
      ? netflixAuth
      : service === "crunchyroll"
        ? crunchyrollAuth
        : null
  // Prefer a named-auth slice; fall back to the full entry list (service unknown).
  const preferred =
    named && named.length > 0
      ? named
      : netflixAuth.length > 0
        ? netflixAuth
        : primeAuth.length > 0
          ? primeAuth
          : crunchyrollAuth.length > 0
            ? crunchyrollAuth
            : allEntries
  // When the service is known, collapse duplicate cookie names to the best variant
  // for that checker's host (e.g. two NetflixId tokens from a confused paste). When
  // unknown, leave entries untouched so we never merge across different services.
  const deduped = service ? dedupeCookiesForHost(preferred, CHECK_TARGET_HOST[service]) : preferred
  return { cookie: serializeCookies(deduped, "RAW"), count: allEntries.length }
}

// Builds the cookie string to PERSIST for a saved / distributed account.
//
// FORMAT: accounts are persisted in their ORIGINAL, checked format — VERBATIM the
// text that was verified — NOT a pre-converted Cookie-Editor JSON blob. This is the
// key fix for the "Failed to parse or set cookie" import errors (e.g. Amazon's
// at-main-av): previously we converted to Cookie-Editor JSON HERE (at storage) and
// then the display/export layer converted that JSON AGAIN at render time
// (cookieToCookieEditorJson / buildAccountDetails both re-run the conversion). That
// double conversion — JSON → parse → re-serialize — is what corrupted individual
// cookies so the browser import failed. Storing the original and converting EXACTLY
// ONCE at the edge removes the round-trip entirely.
//
// Nothing downstream depends on the stored blob already being JSON:
//   • Every "import cookies" / copy button (single checker, bulk checker, admin
//     saved section, and the account-generator claimed screens via ResultReport)
//     converts the stored value on the fly through cookieToCookieEditorJson /
//     buildAccountDetails, so the exported cookie is ALWAYS the auto-converted,
//     browser-importable, persistent-session JSON.
//   • Every recheck path (prepareCookieForCheck) already re-parses ANY format
//     (RAW / JSON / Netscape) down to the clean request header, so verifying a
//     stored original works identically to the interactive checker.
//
// We keep the FULL original set (not the trimmed auth slice) because a real login
// needs every supporting session cookie — importing only `at-main` never restores
// an Amazon session. Cross-site cookies are scoped out later, at conversion time,
// so the stored original stays faithful while exports stay clean.
export function cookieForStorage(text: string, _service: CheckService = "netflix"): string {
  return text.trim()
}

// Valid cookie-name token characters (RFC 6265). This deliberately excludes
// characters found in URLs, emails, and prose ("/", ":", "@", spaces, …) so
// junk tokens around the real cookies get filtered out.
const COOKIE_NAME_RE = /^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/

// True when a parsed entry actually looks like a cookie pair (clean name +
// a non-empty, space-free value). Used to strip everything that is NOT a cookie.
export function isCookieEntry(e: CookieEntry): boolean {
  return COOKIE_NAME_RE.test(e.name) && e.value.length > 0 && !/\s/.test(e.value)
}

// Detection is name + VALUE aware. A real session-auth cookie is a long, high-
// entropy token; matching only the NAME lets junk like `etp_rt=1` or
// `x-main=true` buried in prose/combo dumps masquerade as accounts. These guards
// reject placeholder/sentinel values and anything too short to be a real token,
// so each checker detects ONLY genuine cookies for its own service.

// Logout placeholders and boolean/empty sentinels that sometimes carry a real
// cookie's name but are obviously not a session token.
const JUNK_VALUE_RE = /^(true|false|null|undefined|none|nil|deleted|removed|expired|n\/?a|-+|0+|1)$/i

// True when `value` plausibly looks like a real auth token: at least `minLen`
// characters and not a known junk sentinel.
function isPlausibleTokenValue(value: string, minLen: number): boolean {
  return value.length >= minLen && !JUNK_VALUE_RE.test(value)
}

// ── Netflix ──────────────────────────────────────────────────────────────────
// NetflixId / SecureNetflixId are long URL-encoded blobs ("v%3D2&ct%3D…&mac%3D…").
// These two names are extremely distinctive — they essentially never appear in
// unrelated prose — so a name match plus a non-junk value is enough to qualify
// (a small floor of 2 + the sentinel filter rejects logout placeholders like
// `NetflixId=1` / `=deleted` without false-rejecting real tokens).
const NETFLIX_AUTH_RE = /^(Secure)?NetflixId$/i
function isNetflixAuthEntry(e: CookieEntry): boolean {
  return NETFLIX_AUTH_RE.test(e.name) && isPlausibleTokenValue(e.value, 2)
}
export function hasNetflixAuth(entries: CookieEntry[]): boolean {
  return entries.some(isNetflixAuthEntry)
}

// ── Amazon Prime ─────────────────────────────────────────────────────────────
// Distinctive Amazon SSO auth cookies that only appear in a real signed-in
// session (regional `acbXX` variants and Prime Video `-av` variants included):
//   at-main / at-acbXX / at-main-av        — primary auth token ("Atza|…")
//   sess-at-main / sess-at-acbXX / sess-at-main-av — signed session token
//   x-main / x-main-av                     — main identity cookie
//   ubid-main / ubid-acbXX / ubid-main-av  — authenticated browser id ("NNN-…")
//
// Amazon Prime Video cookies (exported from primevideo.com) carry the same auth
// token names but with an `-av` suffix (e.g. `at-main-av`, `sess-at-main-av`).
// These are equally authoritative sign-in signals — all variants are included.
//
// `lc-main` (locale) and bare `session-id` are intentionally NOT qualifiers — they
// are short/generic and appear on logged-OUT Amazon visits too, so relying on them
// produced false detections. At least one STRONG token above (with a real value)
// is required to call a set an Amazon account.
const PRIME_AUTH_RE =
  /^(at-(main|acb[a-z]{2}|main-av)|sess-at-(main|acb[a-z]{2}|main-av)|x-main(-av)?|ubid-(main|acb[a-z]{2}|main-av))$/i
function isPrimeAuthEntry(e: CookieEntry): boolean {
  return PRIME_AUTH_RE.test(e.name) && isPlausibleTokenValue(e.value, 16)
}
// Prime Video cookies (the "-av" suffix, and Prime Video's own "av-" prefixed ones
// like av-native-app / av-timezone) live ONLY on .primevideo.com. Amazon's non-av SSO
// cookies live on amazon.<tld>. Export domain assignment keys off these — see
// normalizeEntriesForExport. Kept broad (not just auth names) so EVERY primevideo.com
// cookie in a set is stamped onto the correct registrable domain.
const PRIME_AV_COOKIE_RE = /(-av$|^av-)/i
const PRIME_AMAZON_SSO_RE =
  /^(at-main|sess-at-main|x-main|ubid-main|lc-main|(?:at|sess-at|ubid|x)-acb[a-z]{2})$/i
export function hasPrimeAuth(entries: CookieEntry[]): boolean {
  return entries.some(isPrimeAuthEntry)
}

// ── Crunchyroll ──────────────────────────────────────────────────────────────
// `etp_rt` is the web refresh-token cookie used to mint an access token — a long
// token (JWT-style or UUID-bearing), never a short placeholder. It is also the
// EXACT credential the server-side checker authenticates with (the `etp_rt_cookie`
// grant), so detection is intentionally aligned to it: an account is only counted
// when it carries the cookie that can actually be validated. (httpOnly exports
// still include `etp_rt` — cookies.txt just prefixes the domain with `#HttpOnly_`,
// which the scanner handles.)
const CRUNCHYROLL_AUTH_RE = /^etp_rt$/i
function isCrunchyrollAuthEntry(e: CookieEntry): boolean {
  return CRUNCHYROLL_AUTH_RE.test(e.name) && isPlausibleTokenValue(e.value, 20)
}
export function hasCrunchyrollAuth(entries: CookieEntry[]): boolean {
  return entries.some(isCrunchyrollAuthEntry)
}

// ── Steam ──────────���─────────────────────────────────────────────────────────
// `steamLoginSecure` is the signed web-session cookie (format `STEAMID||JWT`) and
// the EXACT credential the server-side checker authenticates with — so detection
// is aligned to it: an account is only counted when it carries the cookie that can
// actually be validated. It's a long token, never a short placeholder.
const STEAM_AUTH_RE = /^steamLoginSecure$/i
function isSteamAuthEntry(e: CookieEntry): boolean {
  return STEAM_AUTH_RE.test(e.name) && isPlausibleTokenValue(e.value, 20)
}
export function hasSteamAuth(entries: CookieEntry[]): boolean {
  return entries.some(isSteamAuthEntry)
}

// ── Spotify ──────────────────────────────────────────────────────────────────
// `sp_dc` is Spotify's long-lived web auth cookie used to mint an access token —
// the EXACT credential the server-side checker authenticates with. It's a long
// opaque token, never a short placeholder.
const SPOTIFY_AUTH_RE = /^sp_dc$/i
function isSpotifyAuthEntry(e: CookieEntry): boolean {
  return SPOTIFY_AUTH_RE.test(e.name) && isPlausibleTokenValue(e.value, 20)
}
export function hasSpotifyAuth(entries: CookieEntry[]): boolean {
  return entries.some(isSpotifyAuthEntry)
}

// A set is a valid account for ANY supported service. Cookie names don't overlap
// between services, so accepting all is safe — the actual service-specific
// validation happens server-side via the `service` flag. This is the single gate
// used by extraction so every checker file imports it.
export function hasAuthCookie(entries: CookieEntry[]): boolean {
  return (
    hasNetflixAuth(entries) ||
    hasPrimeAuth(entries) ||
    hasCrunchyrollAuth(entries) ||
    hasSteamAuth(entries) ||
    hasSpotifyAuth(entries)
  )
}

type CheckService = "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"

// Does a parsed set carry a real auth cookie for THIS specific service?
export function hasServiceAuth(entries: CookieEntry[], service: CheckService): boolean {
  if (service === "netflix") return hasNetflixAuth(entries)
  if (service === "crunchyroll") return hasCrunchyrollAuth(entries)
  if (service === "steam") return hasSteamAuth(entries)
  if (service === "spotify") return hasSpotifyAuth(entries)
  return hasPrimeAuth(entries)
}

// Classifies a SINGLE entry: which service's auth cookie is it (if any)? When
// `restrict` is set, only that service is considered. Used to detect per-account
// boundaries by anchoring on auth cookies rather than on incidental name repeats.
function authServiceOf(e: CookieEntry, restrict?: CheckService): CheckService | null {
  if ((!restrict || restrict === "netflix") && isNetflixAuthEntry(e)) return "netflix"
  if ((!restrict || restrict === "prime") && isPrimeAuthEntry(e)) return "prime"
  if ((!restrict || restrict === "crunchyroll") && isCrunchyrollAuthEntry(e)) return "crunchyroll"
  if ((!restrict || restrict === "steam") && isSteamAuthEntry(e)) return "steam"
  if ((!restrict || restrict === "spotify") && isSpotifyAuthEntry(e)) return "spotify"
  return null
}

// The cookie host(s) each service's session lives on. Used to strip cookies from
// unrelated sites (YouTube, Yandex, Discord, ad networks, …) out of a multi-domain
// `cookies.txt` export so an extracted set only ever carries the target service's
// own cookies. Matching is on the bare host with the leading dot removed, and
// accepts the apex domain plus any subdomain of it.
const SERVICE_HOSTS: Record<CheckService, string[]> = {
  netflix: ["netflix.com"],
  // Amazon auth cookies live on amazon.<tld> (regional) and primevideo.com.
  prime: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.co.jp", "amazon.in", "primevideo.com"],
  crunchyroll: ["crunchyroll.com"],
  // Steam's session cookie lives on the store + community hosts.
  steam: ["steampowered.com", "steamcommunity.com", "steam.tv"],
  spotify: ["spotify.com"],
}

// True when a cookie entry belongs to the given service by domain. Amazon uses
// many regional TLDs, so Prime also accepts any `amazon.<tld>` host.
function entryBelongsToService(e: CookieEntry, service: CheckService): boolean {
  const host = (e.domain || "").replace(/^\./, "").toLowerCase()
  if (!host) return false
  if (service === "prime" && /(^|\.)amazon\.[a-z.]+$/.test(host)) return true
  return SERVICE_HOSTS[service].some((h) => host === h || host.endsWith(`.${h}`))
}

// Restricts a parsed set to ONLY the cookies that belong to `service`, removing
// cross-site junk. Prefers the domain slice when it still contains the service's
// auth cookie. When domains can't be trusted (e.g. RAW headers / a whole browser
// cookie string mashed onto one line whose domain field defaults to a placeholder),
// it can't slice by host — but it MUST still avoid mixing services, so it drops any
// auth cookie that belongs to a DIFFERENT service. That way a line carrying both
// `NetflixId` and `at-main` yields only the requested service's auth cookie under
// each checker (generic, unattributable cookies like `lang`/`sessionid` are kept —
// they're harmless and the server validates by service anyway).
export function restrictEntriesToService(entries: CookieEntry[], service: CheckService): CookieEntry[] {
  const byDomain = entries.filter((e) => entryBelongsToService(e, service))
  if (byDomain.length > 0 && hasServiceAuth(byDomain, service)) return byDomain
  return entries.filter((e) => {
    const svc = authServiceOf(e)
    return svc === null || svc === service
  })
}

// Cleans a chunk of text down to ONLY its real cookie pairs (RAW header form),
// discarding emails, passwords, URLs, labels, and any other non-cookie noise.
// Returns null when the chunk doesn't contain a valid Netflix OR Amazon Prime
// account cookie.
export function cleanCookieSet(text: string, format?: CookieFormat): string | null {
  const fmt = format ?? detectFormat(text)
  const entries = splitCookiesAndText(text, fmt).entries.filter(isCookieEntry)
  if (entries.length === 0 || !hasAuthCookie(entries)) return null
  return serializeCookies(entries, fmt)
}

// Splits a paste (or file) into individual, cleaned cookie sets for bulk checking.
// - JSON blocks and NETSCAPE blocks are treated as one set each.
// - RAW combo-list style (one cookie header per line) becomes one set per line.
// - Blocks are separated by blank lines.
// Every returned set is stripped down to real cookie pairs and must contain a
// Netflix auth cookie — anything that isn't a cookie per account is ignored.
// AUTH-ANCHORED account splitter — the robust boundary detector used to make sure
// EVERY account in a jumbled dump is found, even when its cookies are scattered
// among hundreds of unrelated ones. Unlike a naive splitter that starts a new
// account on ANY repeating cookie name (which shatters a single account whenever a
// non-auth name recurs across subdomains/regional TLDs — e.g. Netflix `flwssn`,
// Amazon `session-id`), this only breaks when:
//   • an auth cookie NAME already seen in the current account reappears (the next
//     account's auth cookie), or
//   • an auth cookie of a DIFFERENT service appears (mixed Netflix/Prime dumps).
// Because each real account contributes exactly one set of auth-cookie names, the
// number of groups equals the number of auth cookies — i.e. the real account
// count. Non-auth groups (trailing junk) are dropped by the caller's auth filter.
// `restrict` confines detection to a single service (used after domain-filtering).
// The account IDENTITY encoded in an auth cookie's value. Steam (and Steam-style)
// tokens are `ACCOUNTID||JWT`, often URL-encoded as `ACCOUNTID%7C%7CJWT`, so the
// part before the separator is the stable per-account id. This lets the splitter
// tell "the same account's token repeated across subdomains" (same id → ONE account)
// apart from "a genuinely new account" (different id → new account). Cookies without
// a `||` separator fall back to their full value, preserving prior name-repeat
// behavior for services like Netflix/Prime whose tokens aren't `id||token` shaped.
function authIdentity(e: CookieEntry): string {
  const v = e.value || ""
  const sepRaw = v.indexOf("||")
  if (sepRaw >= 0) return v.slice(0, sepRaw).toLowerCase()
  const sepEnc = v.toLowerCase().indexOf("%7c%7c")
  if (sepEnc >= 0) return v.slice(0, sepEnc).toLowerCase()
  return v.toLowerCase()
}

function groupByAuthBoundary(records: CookieEntry[], restrict?: CheckService): CookieEntry[][] {
  const groups: CookieEntry[][] = []
  let current: CookieEntry[] = []
  let curService: CheckService | null = null
  // Map of auth-cookie name (lowercased) -> the account identity already seen in the
  // current group. A repeat of the SAME name with the SAME identity is the same
  // account (e.g. Steam's per-subdomain steamLoginSecure tokens, all the same
  // SteamID) and must NOT start a new account; only a DIFFERENT identity does.
  let authIds = new Map<string, string>()
  for (const rec of records) {
    const svc = authServiceOf(rec, restrict)
    if (svc) {
      const nameLower = rec.name.toLowerCase()
      const id = authIdentity(rec)
      const prevId = authIds.get(nameLower)
      const identityRepeatsDifferent = prevId !== undefined && prevId !== id
      const serviceChanged = curService !== null && svc !== curService
      if (current.length > 0 && (identityRepeatsDifferent || serviceChanged)) {
        groups.push(current)
        current = []
        curService = null
        authIds = new Map<string, string>()
      }
    }
    current.push(rec)
    if (svc) {
      curService = svc
      authIds.set(rec.name.toLowerCase(), authIdentity(rec))
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

// Extracts cleaned, per-account cookie sets using the tolerant Netscape scanner.
// When per-account banners ("NETFLIX ACCOUNT DETAILS") are present they are used
// as reliable delimiters; otherwise accounts are split by the repeating-cookie-
// name heuristic. Returns [] when no Netscape records are present so callers can
// fall back to block/combo-list parsing.
function scanNetscapeAccounts(text: string): string[] {
  // Match any service-specific account-header banner that community dump tools
  // insert between accounts: "NETFLIX ACCOUNT DETAILS", "AMAZON ACCOUNT DETAILS",
  // "PRIME ACCOUNT DETAILS", "ACCOUNT DETAILS", etc.
  const BANNER_RE = /(?:NETFLIX|AMAZON|PRIME|ACCOUNT)\s+ACCOUNT\s+DETAILS|^={5,}$/im
  const hasBanner = BANNER_RE.test(text)
  const segments = hasBanner ? text.split(BANNER_RE) : [text]

  const groups: CookieEntry[][] = []
  for (const segment of segments) {
    const records = scanNetscapeRecords(segment)
    if (records.length === 0) continue
    // Banner-delimited segments are already one account each. Otherwise split on
    // auth-cookie boundaries so concatenated accounts with no blank-line/banner
    // separator (and cookies jumbled among other sites) are each found.
    if (hasBanner) groups.push(records)
    else groups.push(...groupByAuthBoundary(records))
  }

  const sets: string[] = []
  for (const group of groups) {
    const clean = group.filter(isCookieEntry)
    if (clean.length > 0 && hasAuthCookie(clean)) {
      sets.push(serializeCookies(clean, "NETSCAPE"))
    }
  }
  return sets
}

// Reassembles every cookie that belongs to `service` from the ENTIRE input —
// no matter how scattered it is across hundreds of unrelated domains — and groups
// it into per-account sets. This is the accurate path for a full browser cookie
// export (one account whose service cookies are interleaved with YouTube, Discord,
// ad-network, analytics cookies, …).
//
// Why this is needed: the generic record grouper starts a new "account" whenever
// ANY cookie name repeats, but names like `__cf_bm`, `_ga`, `lang`, `sessionid`
// recur across dozens of sites — so a single browser export gets shredded into
// many fragments and the service's own cookies end up split across them, losing
// the scattered ones. Here we FIRST keep only the service's own-domain cookies,
// THEN group: after domain-filtering, the only repeated names left are genuine
// account boundaries, so one export stays one complete account with every cookie.
function harvestServiceAccounts(text: string, service: CheckService): string[] {
  const fmt = detectFormat(text)
  // RAW headers carry no domain field to harvest by, and RAW combo lines are
  // already one-account-per-line — leave those to the standard line/block path.
  if (fmt === "RAW") return []

  const all = splitCookiesAndText(text, fmt).entries.filter(isCookieEntry)
  const serviceEntries = all.filter((e) => entryBelongsToService(e, service))
  if (serviceEntries.length === 0 || !hasServiceAuth(serviceEntries, service)) return []

  // Group the domain-filtered entries into accounts. Auth-anchored so a single
  // account is never shattered by a non-auth name that recurs across the service's
  // own subdomains/regional TLDs — every account with an auth cookie is kept.
  return groupByAuthBoundary(serviceEntries, service)
    .filter((group) => hasServiceAuth(group, service))
    .map((group) => serializeCookies(group, fmt))
}

// Splits a SINGLE RAW line into one cleaned set PER account it contains. A normal
// combo line is one account, but "confused" dumps mash several accounts onto one
// line (e.g. `...; sp_dc=AAA; ...; sp_dc=BBB` or two NetflixId tokens), and the old
// per-line clean collapsed them into one mixed set with duplicate auth names. Auth-
// anchored grouping (the same engine that fixed Steam) breaks the line whenever an
// auth cookie of a new identity/service appears, so EVERY account is recovered —
// for Netflix, Prime, Crunchyroll and Spotify alike. Returns [] when the line has no
// auth cookie, so the caller's multi-line fallback (one account spanning lines) is
// preserved unchanged.
function cleanRawLineAccounts(line: string): string[] {
  const entries = splitCookiesAndText(line, "RAW").entries.filter(isCookieEntry)
  if (entries.length === 0 || !hasAuthCookie(entries)) return []
  const out: string[] = []
  for (const group of groupByAuthBoundary(entries)) {
    if (hasAuthCookie(group)) out.push(serializeCookies(group, "RAW"))
  }
  return out
}

// When `service` is specified, only sets that carry auth cookies for that service
// are returned. This prevents Prime files from polluting the Netflix checker and
// vice-versa. Defaults to "any" so existing callers are unaffected.
export function extractCookieSets(
  text: string,
  service: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" | "any" = "any",
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // Strategy 0 (specific service only) — whole-file domain harvest. Catches every
  // scattered service cookie in a full browser export before the order-sensitive
  // block/record strategies run. Skipped for RAW (no domains) and "any".
  if (service !== "any") {
    const harvested = harvestServiceAccounts(trimmed, service)
    if (harvested.length > 0) return harvested
  }

  // Service refiner: when a specific service is requested, a set must (1) carry a
  // real auth cookie for THAT service, and (2) be stripped down to only that
  // service's own cookies — so cross-site junk (Discord, YouTube, ad networks)
  // from a multi-domain export never rides along into the check or the copy. "any"
  // passes sets through untouched. Returns null to drop a non-matching set.
  function refineForService(set: string): string | null {
    if (service === "any") return set
    const fmt = detectFormat(set)
    const entries = splitCookiesAndText(set, fmt).entries.filter(isCookieEntry)
    if (!hasServiceAuth(entries, service)) return null
    const sliced = restrictEntriesToService(entries, service)
    return serializeCookies(sliced, fmt)
  }

  function refineAll(list: string[]): string[] {
    return list.map(refineForService).filter((s): s is string => s !== null)
  }

  // Strategy 0.5 — "checker combo" format.
  // Lines of the form:
  //   email:password | Country = France | Plan = Standard | ... | NetflixCookies = NetflixId=v%3D3%26ct%3D...
  // Each line is one account; the cookie sits after the LAST "NetflixCookies = "
  // token and runs to end-of-line. This pattern is produced by external Netflix
  // checkers (OpenBullet, SilverBullet, etc.) and is not a standard Netscape/RAW/JSON
  // format, so no existing strategy catches it. We detect it by the presence of
  // "NetflixCookies =" on at least ONE line, extract only the cookie portion from
  // every matching line, and feed each into refineAll so the normal auth/service
  // checks still apply. Non-matching lines (headers, blanks) are skipped.
  const COMBO_COOKIE_FULL_RE = /NetflixCookies\s*=/i
  if (COMBO_COOKIE_FULL_RE.test(trimmed)) {
    const comboSets: string[] = []
    for (const line of trimmed.split("\n")) {
      const l = line.trim()
      if (!l) continue
      // Find "NetflixCookies = <value>" — the value ends at the next " | " pair or EOL.
      const idx = l.search(/NetflixCookies\s*=/i)
      if (idx === -1) continue
      const afterEq = l.slice(l.indexOf("=", idx) + 1).trim()
      // The cookie value is everything up to the next " | Key = " or EOL.
      const nextPipe = afterEq.search(/\s+\|\s+[A-Za-z]/)
      const rawCookie = (nextPipe === -1 ? afterEq : afterEq.slice(0, nextPipe)).trim()
      if (rawCookie) comboSets.push(rawCookie)
    }
    if (comboSets.length > 0) return refineAll(comboSets)
  }

  // Strategy 1 — Netscape record scan. Handles the hardest real-world dumps:
  // multiple accounts whose banner + cookies are flattened onto one space-
  // separated line and separated only by noise (no blank lines between them).
  const scanned = scanNetscapeAccounts(trimmed)
  if (scanned.length > 0) return refineAll(scanned)

  // Strategy 2 — blank-line blocks: JSON blocks, RAW combo-lists, multi-line RAW.
  const sets: string[] = []
  const blocks = trimmed.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean)

  for (const block of blocks) {
    const fmt = detectFormat(block)
    if (fmt === "JSON" || fmt === "NETSCAPE") {
      const cleaned = cleanCookieSet(block, fmt)
      if (cleaned) sets.push(cleaned)
      continue
    }

    // RAW: try each line as its own account (combo-list style) first. Each line is
    // further split by auth boundary so a confused line carrying several accounts is
    // fully recovered instead of collapsed into one mixed set.
    const perLine = block.split("\n").flatMap(cleanRawLineAccounts)

    if (perLine.length > 0) {
      sets.push(...perLine)
    } else {
      // Fallback: a single account whose cookies span multiple lines.
      const combined = cleanCookieSet(block, "RAW")
      if (combined) sets.push(combined)
    }
  }
  return refineAll(sets)
}

// Splits ANY messy input into per-account cookie blocks, KEEPING EVERY cookie for
// EVERY domain — NO auth-cookie gate and NO service restriction. This is what the
// admin Cookie Extractor uses (distinct from extractCookieSets, which is built for
// the CHECKER and deliberately drops any set lacking a Netflix/Prime/Crunchyroll
// auth cookie). Here nothing is dropped, so cookies for all catalogued services
// (and unlisted sites) survive to be sorted by domain downstream.
//
// ACCOUNT MODEL: one browser export = ONE account, even though it holds cookies
// for dozens of sites (and legitimately repeats a (domain,path,name) triple, e.g.
// host-only + dotted variants). So a continuous Netscape dump is NEVER split by
// cookie heuristics — that would shatter a single account into fragments and drop
// data. Accounts are separated ONLY by explicit delimiters:
//   • an account banner ("NETFLIX ACCOUNT DETAILS", a ==== rule), or
//   • a fresh "# Netscape HTTP Cookie File" header (each export starts with one),
//   • or a blank line / one-account-per-line for JSON & RAW combolists.
// In the folder-of-1000-files flow each file is parsed on its own, so it naturally
// yields one account per file regardless of the in-file delimiters.
export function extractAllCookieBlocks(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // Strategy 1 ��� Netscape records (the dominant export shape). Split only on
  // explicit account delimiters; each delimited segment is one whole account.
  if (/TRUE|FALSE/i.test(trimmed)) {
    const DELIM_RE = /(?:NETFLIX|AMAZON|PRIME|ACCOUNT)\s+ACCOUNT\s+DETAILS|^={5,}$|^#\s*Netscape HTTP Cookie File/im
    const segments = trimmed.split(DELIM_RE)
    const groups: CookieEntry[][] = []
    for (const segment of segments) {
      const records = scanNetscapeRecords(segment).filter(isCookieEntry)
      if (records.length > 0) groups.push(records)
    }
    const sets = groups.map((g) => serializeCookies(g, "NETSCAPE"))
    if (sets.length > 0) return sets
  }

  // Strategy 2 — blank-line blocks: JSON exports, RAW combolists, multi-line RAW.
  const sets: string[] = []
  const blocks = trimmed.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean)
  for (const block of blocks) {
    const fmt = detectFormat(block)
    if (fmt === "JSON" || fmt === "NETSCAPE") {
      const entries = splitCookiesAndText(block, fmt).entries.filter(isCookieEntry)
      if (entries.length > 0) sets.push(serializeCookies(entries, fmt))
      continue
    }
    // RAW: one account per line (combolist) first…
    const perLine = block
      .split("\n")
      .map((l) => {
        const entries = splitCookiesAndText(l, "RAW").entries.filter(isCookieEntry)
        return entries.length > 0 ? serializeCookies(entries, "RAW") : null
      })
      .filter((s): s is string => s !== null)
    if (perLine.length > 0) {
      sets.push(...perLine)
    } else {
      // …otherwise treat the whole block as one multi-line account.
      const entries = splitCookiesAndText(block, "RAW").entries.filter(isCookieEntry)
      if (entries.length > 0) sets.push(serializeCookies(entries, "RAW"))
    }
  }
  return sets
}

// A compact, human-readable label for a cookie set (used in the bulk table).
export function setLabel(text: string): string {
  const fmt = detectFormat(text)
  const { entries } = splitCookiesAndText(text, fmt)
  const id = entries.find((e) => /^(Secure)?NetflixId$/i.test(e.name))
  if (id) return `${id.name}=${id.value.slice(0, 14)}…`
  if (entries[0]) return `${entries[0].name}=${entries[0].value.slice(0, 14)}…`
  return text.slice(0, 24)
}

const DETAILS_CREDIT = "cookiesmo.i4n.tech"

// Pretty labels for known raw API keys so unmapped extras still read cleanly.
const RAW_KEY_LABELS: Record<string, string> = {
  x_mail: "Email",
  x_tier: "Plan",
  x_loc: "Country",
  x_mem: "Member Since",
  x_bil: "Payment",
  x_tel: "Phone",
  x_usr: "Profiles",
  x_qual: "Quality",
  x_stream: "Streams",
  x_extra: "Extra Member",
  x_ren: "Next Billing",
}

const HANDLED_RAW_KEYS = new Set([
  "x_mail",
  "x_tier",
  "x_loc",
  "x_mem",
  "x_bil",
  "x_tel",
  "x_usr",
  "x_ren",
  "x_l1",
  "x_l2",
  "x_l3",
  "status",
  "valid",
  "success",
  "message",
])

export function prettyKey(key: string): string {
  if (RAW_KEY_LABELS[key]) return RAW_KEY_LABELS[key]
  return key
    .replace(/^x_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Extracts ONLY the cookie pairs from a pasted blob, preserving the ORIGINAL
// detected format (RAW header, Netscape, JSON, …). It strips surrounding noise
// (emails, labels, blank lines) but never converts between formats — so a JSON
// cookie stays JSON, a Netscape dump stays Netscape. This is the single source of
// truth for every "copy cookie" / cookie export path so they stay consistent.
// Falls back to the trimmed input when no cookie entries can be parsed.
export function cookieOnlyText(text: string): string {
  const fmt = detectFormat(text)
  const { entries } = splitCookiesAndText(text, fmt)
  return entries.length > 0 ? serializeCookies(entries, fmt) : text.trim()
}

// Far-future expiry (Jan 2033) used when a parsed cookie has no expiry of its own
// (RAW headers carry none). A real timestamp — never 0 — so importers treat the
// cookie as persistent instead of a session cookie that's dropped on browser close.
const DEFAULT_COOKIE_EXPIRY = 1988150400

// The browser cookie API expects `expirationDate` as Unix seconds. But pasted JSON
// dumps sometimes carry MILLISECONDS (e.g. 1988150400000) or a float. Feeding that
// straight to Cookie-Editor makes `chrome.cookies.set` reject the cookie for an
// out-of-range date — which silently aborts the whole import ("sometimes it doesn't
// work"). This coerces any expiry to a sane integer number of SECONDS: values that
// look like ms are divided down, non-positive/NaN falls back to the default, and
// anything absurdly far out is clamped so every exported cookie imports cleanly.
const MAX_COOKIE_EXPIRY = 2147483647 // 2038 — safely within every browser's accepted range
function normalizeExpirySeconds(expiry: number): number {
  let e = Number(expiry)
  if (!Number.isFinite(e) || e <= 0) return DEFAULT_COOKIE_EXPIRY
  // Milliseconds (13+ digits) → seconds. 1e12 s would be year 33658, so any value
  // above that threshold is certainly a millisecond timestamp.
  if (e > 1e12) e = e / 1000
  e = Math.floor(e)
  if (e > MAX_COOKIE_EXPIRY) e = MAX_COOKIE_EXPIRY
  return e
}

// Removes a single pair of BALANCED wrapping double-quotes from a cookie value.
// Makes a cookie value safe for `chrome.cookies.set` (and therefore for a clean
// Cookie-Editor import). RFC 6265's cookie-octet grammar FORBIDS the double-quote,
// control characters, and surrounding whitespace, and the browser API rejects any
// value that contains them — surfacing as Cookie-Editor's "Failed to parse or set
// cookie named <X>" error, which ABORTS the whole import at that single cookie.
//
// Amazon is the usual source: it wraps auth cookies as RFC 6265 quoted-strings
// (at-main-av="Atza|…"), and a RAW/concatenated paste can leave a BALANCED wrapper,
// a STRAY unbalanced quote (e.g. lc-main-av — the reported failure), or an embedded
// quote inside the token. The old logic only stripped a balanced outer pair, so a
// stray/embedded quote still slipped through and broke the import.
//
// We therefore: (1) trim surrounding whitespace, (2) repeatedly peel balanced outer
// quotes (handles accidental double-wrapping), then (3) remove any REMAINING raw
// double-quote and control characters. Streaming auth tokens are URL/base64-style
// (A–Z a–z 0–9 and | + / = _ - . %), so none of these strips ever alters a real
// value — it only removes characters a browser would reject anyway.
function sanitizeCookieValue(value: string): string {
  if (typeof value !== "string") return ""
  let v = value.trim()
  while (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).trim()
  }
  // Strip stray double-quotes and control chars (0x00–0x1F, 0x7F) left anywhere.
  // eslint-disable-next-line no-control-regex
  return v.replace(/["\u0000-\u001F\u007F]/g, "")
}

// Converts ANY pasted cookie (RAW header, JSON, or Netscape) into a clean, VALID
// Netscape `cookies.txt` block: a `# Netflix HTTP Cookie File` header followed by
// ONE cookie per line (tab-separated domain/flag/path/secure/expiry/name/value).
// This is the universal, importable format used by browser cookie extensions, so
// every "copy / export cookie" path emits proper multi-line cookies instead of a
// single long RAW line. Falls back to the trimmed input if nothing parses.
// The canonical login domain for a service, used as the fallback for domainless
// cookies (e.g. RAW `name=value` pastes carry no domain). Exported so the format
// converter can stamp the CORRECT service domain when turning a RAW paste into
// NETSCAPE/JSON, instead of the generic ".netflix.com" placeholder.
export function serviceDefaultDomain(service: CheckService): string {
  return `.${SERVICE_HOSTS[service][0]}`
}

// Parses ANY pasted cookie (RAW / JSON / Netscape) and returns clean entries
// stamped for reliable browser re-import: correct service domain, Secure on, and
// a real (persistent) expiry. Shared by every export format so Netscape and JSON
// outputs are always consistent. Returns [] when nothing parses.
function normalizeEntriesForExport(text: string, service: CheckService): CookieEntry[] {
  const fmt = detectFormat(text)
  const parsed = splitCookiesAndText(text, fmt).entries.filter(isCookieEntry)
  if (parsed.length === 0) return []
  // Drop ONLY unrelated cross-site cookies from a multi-domain browser export so the
  // exported/stored set is scoped to THIS service's domains. We intentionally keep
  // EVERY one of the service's own cookies — the full, unstripped, browser-importable
  // session — because trimming to a "session subset" risks dropping a cookie the
  // account actually needs to work. Falls back to the full set if scoping leaves
  // nothing usable. This full set is what every copy/export/storage/generator path
  // hands out (they all route through here).
  const scoped = restrictEntriesToService(parsed, service)
  const scopedEntries = scoped.length > 0 ? scoped : parsed
  // DE-DUPLICATE before export. A pasted blob often contains the same cookie more
  // than once (users concatenate multiple exports, or a browser dump repeats a
  // cookie across host + dot domains). Emitting duplicates makes Cookie-Editor /
  // the browser import an arbitrary copy — sometimes the STALE or empty one — which
  // is the classic "the import sometimes doesn't work" symptom. We collapse by
  // name+domain+path, always keeping the LAST occurrence that has a non-empty value
  // (later entries are the freshest), so every exported session is clean and the
  // real auth cookie always wins.
  const deduped = new Map<string, CookieEntry>()
  for (const c of scopedEntries) {
    const key = `${c.name}\u0000${(c.domain || "").toLowerCase()}\u0000${c.path || "/"}`
    const existing = deduped.get(key)
    // Keep the incoming one unless it's empty and we already have a non-empty value.
    if (existing && !c.value && existing.value) continue
    deduped.set(key, c)
  }
  const entries = Array.from(deduped.values())
  const fallback = serviceDefaultDomain(service)
  // PRIME spans TWO registrable domains, and stamping a cookie on the wrong one makes
  // the browser drop it (session bounces to sign-in) AND makes Cookie-Editor reject it
  // ("Failed to parse or set cookie named at-main-av"). A session captured from
  // primevideo.com is a domainless RAW header, so the old single fallback (.amazon.com)
  // mis-stamped the Prime Video "-av" cookies onto .amazon.com. We resolve per NAME:
  //   • "-av"/"av-" cookies (at-main-av, sess-at-main-av, x-main-av, ubid-main-av,
  //     lc-main-av, av-native-app, av-timezone, …) live ONLY on .primevideo.com.
  //   • non-av SSO cookies (at-main, sess-at-main, x-main, ubid-main, lc-main, regional
  //     *-acbXX) live on amazon.<tld>.
  //   • shared/generic (session-id, session-token, i18n-prefs, csm-hit, …) keep a valid
  //     existing host, else follow the set's dominant property.
  const setPrefersAv =
    service === "prime" &&
    entries.some(
      (c) => PRIME_AV_COOKIE_RE.test(c.name || "") || /(^|\.)primevideo\.com$/i.test((c.domain || "").replace(/^\./, "")),
    )
  const resolveDomain = (c: CookieEntry): string => {
    if (service !== "prime") {
      // For non-Prime, a ".netflix.com" domain is only ever the parser's placeholder
      // for a domainless RAW/JSON cookie — re-stamp those with the service domain.
      const isDefaultedToNetflix = !c.domain || /(^|\.)netflix\.com$/i.test(c.domain)
      return service !== "netflix" && isDefaultedToNetflix ? fallback : c.domain || fallback
    }
    const name = c.name || ""
    const host = (c.domain || "").replace(/^\./, "").toLowerCase()
    // "-av"/"av-" cookies are ONLY valid on primevideo.com. (Re)stamp anything else —
    // this fills domainless pastes AND repairs a prior mis-stamp (e.g. .amazon.com).
    if (PRIME_AV_COOKIE_RE.test(name)) return host.endsWith("primevideo.com") ? (c.domain as string) : ".primevideo.com"
    // non-av SSO cookies are Amazon retail — keep a valid regional amazon host, else .amazon.com.
    if (PRIME_AMAZON_SSO_RE.test(name)) return /(^|\.)amazon\.[a-z.]+$/.test(host) ? (c.domain as string) : ".amazon.com"
    // shared/generic — keep an existing valid Prime host, else follow the set.
    const curValid = (host.endsWith("primevideo.com") || /(^|\.)amazon\.[a-z.]+$/.test(host)) && !!host
    if (curValid) return c.domain as string
    return setPrefersAv ? ".primevideo.com" : ".amazon.com"
  }
  return entries.map((c) => {
    const domain = resolveDomain(c)
    return {
      ...c,
      // IMPORT RELIABILITY — sanitize the value so chrome.cookies.set never rejects it
      // (Amazon quoted-strings, stray/embedded quotes, control chars). See
      // sanitizeCookieValue: a single rejected cookie (e.g. lc-main-av) otherwise
      // aborts the entire Cookie-Editor import with "Failed to parse or set cookie".
      value: sanitizeCookieValue(c.value),
      domain,
      path: c.path || "/",
      // IMPORT RELIABILITY — Netflix, Amazon, and Crunchyroll are ALL HTTPS-only, and
      // their real session/auth cookies are set with the Secure attribute. A RAW or
      // JSON paste usually omits that attribute, so it would export as `Secure=FALSE`;
      // re-importing such a cookie can fail to authenticate because the browser won't
      // treat it as the site's real (Secure) cookie. Stamp Secure on every exported
      // entry so the imported set matches how the browser actually stores it.
      secure: true,
      // EXPIRY: always export as a PERSISTENT cookie. The streaming auth cookies these
      // services rely on (Amazon's at-main / sess-at-main / x-main / ubid-main, Netflix's
      // NetflixId / SecureNetflixId, Crunchyroll's etp_rt) are PERSISTENT in a real
      // browser, with expiries years out. Exporting them as SESSION cookies (expiry 0 →
      // `session:true`, no `expirationDate`) made the browser DROP them on close, so the
      // imported session was not fully logged in and "expired" immediately — the reported
      // bug. We now KEEP the cookie's own expiry when it has one, and stamp the far-future
      // DEFAULT_COOKIE_EXPIRY (Jan 2033) when it doesn't (RAW/JSON pastes carry none).
      // `normalizeExpirySeconds` guarantees a sane integer number of SECONDS (coercing
      // millisecond timestamps and clamping absurd values), so `chrome.cookies.set` never
      // rejects the date — keeping import reliability while making the login persist.
      expiry: normalizeExpirySeconds(c.expiry),
      // A dot-prefixed export domain is, by definition, NOT host-only.
      hostOnly: c.hostOnly ?? !domain.startsWith("."),
    }
  })
}

export function cookieToNetscape(text: string, service: CheckService = "netflix"): string {
  const normalized = normalizeEntriesForExport(text, service)
  if (normalized.length === 0) return text.trim()
  return ["# Netscape HTTP Cookie File", serializeCookies(normalized, "NETSCAPE")].join("\n")
}

// Converts ANY pasted cookie into the Cookie-Editor / EditThisCookie JSON array —
// the one-click "Import" format supported by the Cookie-Editor extension across
// Chrome, Edge, Firefox, Brave, Opera, and Safari. This is the most reliable way
// to load a working session into any browser. Falls back to the trimmed input.
export function cookieToCookieEditorJson(text: string, service: CheckService = "netflix"): string {
  const normalized = normalizeEntriesForExport(text, service)
  // GUARANTEE the output is a browser-importable JSON ARRAY. Cookie-Editor /
  // EditThisCookie only accept a JSON array; returning raw text on a parse miss
  // would make the extension reject the paste outright. We also drop any entry
  // whose name is blank (extensions throw "cookie name is required") so nothing in
  // the array can abort the import. The empty-array fallback still parses cleanly.
  const clean = normalized.filter((c) => typeof c.name === "string" && c.name.trim().length > 0)
  if (clean.length === 0) return "[]"
  const json = serializeCookies(clean, "JSON")
  // Final self-check: if serialization somehow produced invalid JSON, fail safe to
  // an empty array rather than a string the importer can't read.
  try {
    JSON.parse(json)
    return json
  } catch {
    return "[]"
  }
}

// Builds the shareable account-details block from the result + raw payload.
// `position` adds a clear "ACCOUNT #n of total" banner so bulk exports are easy to scan.
export function buildAccountDetails(
  result: CheckResult,
  cookie: string,
  position?: { index: number; total: number },
  service: CheckService = "netflix",
): string {
  const divider = "═".repeat(33)
  const longDivider = "═".repeat(60)
  const raw = (result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>) : {}) || {}

  const lines: string[] = []
  const add = (label: string, value?: string | number | boolean) => {
    if (value === undefined || value === null || value === "") return
    lines.push(`– ${label}: ${value}`)
  }

  // Prime, Crunchyroll, Steam and Spotify lead with the account-holder Name
  // rather than a Netflix-style profiles list.
  const isPrime = service === "prime"
  const isCrunchyroll = service === "crunchyroll"
  const isTrimmed = isPrime || isCrunchyroll || service === "steam" || service === "spotify"

  const name = result.profiles?.[0] ?? result.email
  add("Name", name)
  add("Email", result.email)
  add("Country", result.countryCode)
  // Prime hides the plan entirely; Netflix & Crunchyroll keep it (the membership
  // tier is the point of the Crunchyroll check).
  if (!isPrime) add("Plan", normalizePlan(result.plan))
  if (result.extraMember) add("Extra Member", "Yes")
  add("Member Since", result.memberSince)
  add("Next Billing", result.nextBillingCycle)
  add("Payment", result.paymentMethod)
  add("Phone", result.phone)
  if (typeof result.maxStreams === "number") add("Streams", result.maxStreams)
  if (typeof result.emailVerified === "boolean") add("Email Verified", result.emailVerified ? "Yes" : "No")
  // Profiles are a Netflix-only readout — Prime & Crunchyroll omit profile stats.
  if (!isTrimmed && result.profiles?.length) add("Profiles", result.profiles.join(", "))

  for (const [key, value] of Object.entries(raw)) {
    if (HANDLED_RAW_KEYS.has(key.toLowerCase())) continue
    if (value === null || typeof value === "object") continue
    add(prettyKey(key), String(value))
  }

  // Steam: append the full owned-games library (count header + one title per line,
  // with playtime when known). Skipped entirely for the other services.
  if (service === "steam" && result.games?.length) {
    add("Games Owned", result.gameCount ?? result.games.length)
    lines.push("")
    lines.push("GAMES:")
    for (const g of result.games) {
      const hrs = typeof g.hoursOnRecord === "number" && g.hoursOnRecord > 0 ? ` (${g.hoursOnRecord} h)` : ""
      lines.push(`– ${g.name}${hrs}`)
    }
  }

  add("PC Link", result.links?.pc)
  add("Mobile Link", result.links?.mobile)
  add("TV Link", result.links?.tv)

  // Prime downloads use the native Netscape format so browser cookie tools can
  // import the complete Amazon session without a JSON wrapper. Other services keep
  // the existing Cookie-Editor JSON presentation.
  const cookieOnly = service === "prime" ? cookieToNetscape(cookie, service) : cookieToCookieEditorJson(cookie, service)

  const serviceTitle =
    service === "prime"
      ? "AMAZON PRIME"
      : service === "crunchyroll"
        ? "CRUNCHYROLL"
        : service === "steam"
          ? "STEAM"
          : service === "spotify"
            ? "SPOTIFY"
            : "NETFLIX"
  const heading = position
    ? `${serviceTitle} ACCOUNT DETAILS  ::  #${position.index} of ${position.total}`
    : `${serviceTitle} ACCOUNT DETAILS`

  return [
    divider,
    heading,
    `BY: ${DETAILS_CREDIT}`,
    divider,
    ...lines,
    "",
    "COOKIE (browser import — paste into the Cookie-Editor extension):",
    longDivider,
    cookieOnly,
    longDivider,
  ].join("\n")
}

// Joins multiple account blocks with a strong visual separator so each
// account is clearly delimited and easy to read in copied/exported output.
export function joinAccountDetails(blocks: string[]): string {
  const separator = "\n\n\n" + "█".repeat(60) + "\n\n\n"
  return blocks.join(separator)
}

// Runs a CPU-heavy per-item `build` over a large list WITHOUT freezing the tab.
// Each buildAccountDetails/cookie export call does real work (cookie parsing +
// regex scans + serialization), so mapping thousands of rows synchronously on a
// click locks the main thread for seconds — that's the "Copy all details" lag on
// 2k+ results. This processes the list in chunks and yields to the event loop
// between chunks (via a macrotask) so the browser can keep painting and stay
// responsive, while reporting progress. Order is preserved.
export async function mapChunked<T>(
  items: T[],
  build: (item: T, index: number) => string,
  opts?: { chunkSize?: number; onProgress?: (done: number, total: number) => void },
): Promise<string[]> {
  const total = items.length
  const chunkSize = Math.max(1, opts?.chunkSize ?? 150)
  const out: string[] = new Array(total)
  for (let i = 0; i < total; i++) {
    out[i] = build(items[i], i)
    // Yield after each chunk (but never after the final item) so the UI thread
    // gets a breath between bursts of work.
    if ((i + 1) % chunkSize === 0 && i + 1 < total) {
      opts?.onProgress?.(i + 1, total)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  opts?.onProgress?.(total, total)
  return out
}

// Strips characters that are illegal in file/folder names across OSes.
export function sanitizeFileName(value?: string, fallback = "UNKNOWN"): string {
  const cleaned = (value ?? "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || fallback
}

// Folder name for the ZIP export — grouped by account country.
export function accountCountry(result?: CheckResult): string {
  return sanitizeFileName(result?.countryCode, "UNKNOWN")
}

// Folder name for the ZIP export — grouped by account plan.
export function accountPlan(result?: CheckResult): string {
  return sanitizeFileName(normalizePlan(result?.plan), "UNKNOWN")
}

// File name for a single account inside the ZIP, formatted as [PLAN][EMAIL].txt.
export function accountFileName(result?: CheckResult, fallback = "account"): string {
  const plan = sanitizeFileName(result?.plan, "UNKNOWN")
  const email = sanitizeFileName(result?.email, fallback)
  return `[${plan}][${email}].txt`
}

// Sends a single cookie set to the verification API route. `includeLinks` opts
// into minting Netflix login/auth links (an extra upstream request) — off by
// default for speed.
export async function checkCookie(
  rawText: string,
  signal?: AbortSignal,
  opts?: { includeLinks?: boolean; service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" },
): Promise<CheckResult> {
  // Normalize with the SAME service the check targets. Without the service arg this
  // falls back to Netflix-mode trimming, which strips Prime/Steam/Spotify auth
  // cookies (at-main-av, x-main-av, session-token, …) and leaves the session
  // unauthenticated → the service bounces to sign-in and a VALID cookie reads as
  // "expired". The account generator always normalizes with the service, which is
  // why it hands out working Prime accounts the single checker wrongly failed.
  const { cookie } = prepareCookieForCheck(rawText, opts?.service)
  if (!cookie) return { valid: false, message: "No valid cookies found." }
  const res = await fetch("/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A single check goes DIRECT server-side (fastest, no proxy-induced false
    // deads), so no proxies are attached — the request fires immediately.
    body: JSON.stringify({
      cookie,
      includeLinks: opts?.includeLinks === true,
      // Which service to validate against (defaults to Netflix server-side).
      service: opts?.service,
    }),
    signal,
  })
  const data = (await res.json().catch(() => null)) as CheckResult | null
  if (!data || (!res.ok && typeof data.valid !== "boolean")) {
    throw new Error(data?.message || "Request failed.")
  }
  return data
}

export type BatchResponse = {
  results: CheckResult[]
  // Set when the server returned 429; carries when the limit resets (epoch ms).
  rateLimited: boolean
  retryAfterMs?: number
  // Set when OUR client-side timeout fired (server too slow / killed). The caller
  // treats this as a transient, retryable condition instead of surfacing the raw
  // "signal timed out" DOMException to every row.
  timedOut?: boolean
  // Number of proxies the server currently has in its rotation pool. The client
  // uses this to raise its concurrency ceiling (load is spread across IPs). 0 or
  // undefined means direct connection (gentle single-IP limits apply).
  proxies?: number
}

// Hard ceiling for a single chunk request. Must comfortably exceed the server's
// own maxDuration (60s) so the server always gets a chance to respond first; we
// only abort if the platform truly killed/lost the request, leaving the fetch
// hanging forever (the bug that left rows stuck on "CHECKING"). A timeout here
// is reported as `timedOut` so the caller can retry the batch transparently.
const CHUNK_TIMEOUT_MS = 65_000

// Sends a batch of cookies to the verification API route in a single round-trip.
// The server fans them out against its own keep-alive pool (#3), so this removes
// N-1 client→server round-trips compared to calling checkCookie() per cookie.
// On a 429 it reports `rateLimited`; on our client timeout it reports `timedOut`.
export async function checkCookieBatch(
  cookies: string[],
  signal?: AbortSignal,
  opts?: {
    includeLinks?: boolean
    useProxies?: boolean
    manualProxies?: ParsedProxy[]
    // Which service to validate against (defaults to Netflix server-side).
    service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
    // Fires the INSTANT each cookie's verdict streams back from the server (NDJSON),
    // before the whole batch finishes — so the caller can update each row live and a
    // slow cookie never holds up its peers. `index` is the cookie's position in the
    // input array. The full assembled `results` is still returned for bookkeeping.
    onResult?: (index: number, result: CheckResult) => void
  },
): Promise<BatchResponse> {
  if (cookies.length === 0) return { results: [], rateLimited: false }
  // Combine the caller's stop signal with a timeout so a stuck/killed server
  // request can never freeze the run. AbortSignal.any is supported in all
  // modern browsers; the timeout fires independently of the user-stop signal.
  const timeout = AbortSignal.timeout(CHUNK_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  // Attach this session's OWN freshly-scraped + Netflix-tested proxies (fastest-
  // first) ONLY when the run routes through proxies. Admin direct runs send none,
  // so the server checks straight from its own IP.
  const liveProxies = opts?.useProxies === false ? [] : opts?.manualProxies?.length ? [] : getLiveProxySlice()

  let res: Response
  try {
    res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookies,
        includeLinks: opts?.includeLinks === true,
        liveProxies,
        manualProxies: opts?.manualProxies,
        service: opts?.service,
      }),
      signal: combined,
    })
  } catch (err) {
    // A user-initiated stop must propagate so the run can halt.
    if (signal?.aborted) throw err
    // Otherwise this is our own timeout firing, or a transient network blip.
    // Report it as retryable instead of leaking the raw "signal timed out".
    return { results: [], rateLimited: false, timedOut: true }
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"))
    return {
      results: [],
      rateLimited: true,
      retryAfterMs: Number.isNaN(retryAfter) ? 5_000 : Math.max(1_000, retryAfter * 1000),
    }
  }

  // Server-side failure (5xx / killed invocation): treat as retryable timeout-ish
  // rather than a hard per-row error so the batch can be retried.
  if (res.status >= 500) {
    return { results: [], rateLimited: false, timedOut: true }
  }

  // The batch route streams NDJSON: a `meta` line (proxy count), then one `result`
  // line per cookie flushed as it resolves, then `done`. Read incrementally so the
  // caller's onResult fires per cookie instead of waiting for the whole batch.
  if (!res.body) return { results: [], rateLimited: false, timedOut: true }
  const onResult = opts?.onResult
  const results: CheckResult[] = []
  let proxies = 0
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const obj = JSON.parse(trimmed) as { type?: string; index?: number; result?: CheckResult; proxies?: number }
      if (obj.type === "meta") {
        proxies = typeof obj.proxies === "number" ? obj.proxies : 0
      } else if (obj.type === "result" && typeof obj.index === "number" && obj.result) {
        results[obj.index] = obj.result
        onResult?.(obj.index, obj.result)
      }
    } catch {
      // ignore malformed line
    }
  }
  // A connection can remain open without producing data when the last upstream
  // worker wedges. The overall timeout is deliberately generous, but the idle
  // watchdog makes the tail recoverable instead of waiting on a silent stream.
  const STREAM_IDLE_TIMEOUT_MS = 15_000
  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("Batch stream idle timeout")), STREAM_IDLE_TIMEOUT_MS),
        ),
      ])
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    if (buf) handleLine(buf) // trailing partial line
  } catch (err) {
    // Stream aborted/broke mid-way. A user stop must propagate; otherwise report a
    // retryable timeout while preserving any verdicts already streamed.
    if (signal?.aborted) throw err
    return { results, rateLimited: false, timedOut: true, proxies }
  }
  return { results, rateLimited: false, proxies }
}

// ----- Client-side result cache (#cache) -----
// Re-running the same paste (or overlapping pastes) reuses recent results
// instead of re-hitting the upstream. Keyed by the cleaned cookie string with a
// short TTL so stale "alive" states don't linger.
const CACHE_TTL_MS = 5 * 60 * 1000
const resultCache = new Map<string, { result: CheckResult; expires: number }>()

export function getCachedResult(cookie: string): CheckResult | undefined {
  const hit = resultCache.get(cookie)
  if (!hit) return undefined
  if (Date.now() > hit.expires) {
    resultCache.delete(cookie)
    return undefined
  }
  return hit.result
}

export function setCachedResult(cookie: string, result: CheckResult): void {
  // Never cache transient errors — those should be retried, not remembered.
  if (result.errorCategory) return
  resultCache.set(cookie, { result, expires: Date.now() + CACHE_TTL_MS })
}

export function clearResultCache(): void {
  resultCache.clear()
}

// Drops a single cookie's cached verdict so the next check re-dials it for real.
// Used by "Recheck dead" to force a genuine retry instead of reusing the stale result.
export function clearCachedResult(cookie: string): void {
  resultCache.delete(cookie)
}

// Runs an async worker over items with a bounded concurrency pool (efficient bulk checking).
export async function runPool<T>(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
): Promise<void> {
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
