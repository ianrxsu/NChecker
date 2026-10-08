import {
  detectFormat,
  splitCookiesAndText,
  serializeCookies,
  isCookieEntry,
  type CookieEntry,
} from "@/lib/cookie-utils"

// ──────────────────────────────────────────────────────────────────────────────
// Service catalogue
//
// The admin Cookie Extractor sorts a messy pile of cookies (pasted text, files,
// zip/rar/gz archives — folder by folder) into per-service buckets. A "service"
// is identified purely by the COOKIE DOMAIN, which is reliable across every
// export format and needs no auth-cookie knowledge. This lets us recognise the
// full list below, not just the three we can actively check.
//
// `match` accepts the bare cookie host (leading dot + `#HttpOnly_` prefix already
// stripped, lowercased). A host matches a service when it equals one of the
// service's domains or is a subdomain of it.
// ──────────────────────────────────────────────────────────────────────────────

export type ExtractMode = "listed" | "all"

export type ServiceDef = {
  id: string
  label: string
  domains: string[]
  // Optional extra predicate for irregular domains (e.g. Amazon's many TLDs).
  extra?: (host: string) => boolean
}

// Order here is the display/sort order in the UI and ZIP.
export const EXTRACTOR_SERVICES: ServiceDef[] = [
  { id: "netflix", label: "Netflix", domains: ["netflix.com"] },
  { id: "crunchyroll", label: "Crunchyroll", domains: ["crunchyroll.com"] },
  {
    id: "prime",
    label: "Prime Video",
    domains: ["primevideo.com", "amazon.com"],
    // Amazon auth cookies live on many regional TLDs (amazon.co.uk, amazon.de …).
    extra: (h) => /(^|\.)amazon\.[a-z.]+$/.test(h),
  },
  { id: "disney", label: "Disney+", domains: ["disneyplus.com", "disney.com", "bamgrid.com", "dssott.com"] },
  { id: "spotify", label: "Spotify", domains: ["spotify.com"] },
  { id: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { id: "google", label: "Google", domains: ["google.com", "accounts.google.com", "google.co.uk"] },
  { id: "disneyhotstar", label: "Hotstar", domains: ["hotstar.com"] },
  { id: "tiktok", label: "TikTok", domains: ["tiktok.com"] },
  { id: "twitter", label: "Twitter (X)", domains: ["twitter.com", "x.com"] },
  { id: "facebook", label: "Facebook", domains: ["facebook.com"] },
  { id: "steam", label: "Steam", domains: ["steamcommunity.com", "steampowered.com", "steam.tv"] },
  { id: "chatgpt", label: "ChatGPT", domains: ["chatgpt.com", "chat.openai.com", "openai.com", "auth0.openai.com"] },
  { id: "claude", label: "Claude", domains: ["claude.ai", "anthropic.com"] },
  { id: "grok", label: "Grok", domains: ["grok.com", "x.ai"] },
  { id: "cursor", label: "Cursor", domains: ["cursor.com", "cursor.sh"] },
  { id: "outlook", label: "Outlook", domains: ["outlook.com", "live.com", "office.com", "office365.com"] },
  { id: "yahoo", label: "Yahoo", domains: ["yahoo.com", "yahoo.co.jp"] },
]

const SERVICE_ORDER = new Map(EXTRACTOR_SERVICES.map((s, i) => [s.id, i]))

// Normalise a raw cookie domain into a comparable host: drop the Netscape
// `#HttpOnly_` prefix and any leading dot, then lowercase.
function normalizeHost(rawDomain: string): string {
  return rawDomain
    .replace(/^#HttpOnly_/i, "")
    .replace(/^\./, "")
    .trim()
    .toLowerCase()
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

// Which listed service (if any) does this host belong to?
export function serviceForHost(host: string): ServiceDef | null {
  for (const svc of EXTRACTOR_SERVICES) {
    if (svc.domains.some((d) => hostMatchesDomain(host, d))) return svc
    if (svc.extra?.(host)) return svc
  }
  return null
}

// HIGH-confidence, service-distinctive cookie NAMES. Used to attribute a cookie
// that carries NO usable domain (e.g. a RAW `name=value` header pasted loose in
// text, scattered among unrelated pairs) — which the domain sorter would otherwise
// drop entirely. Only names that essentially never collide across services are
// listed, so name-based attribution can't mis-bucket a cookie. Generic/shared names
// (session-id, sessionid, SAPISID, next-auth, …) are deliberately excluded — when a
// domain is absent they're unattributable ON THEIR OWN, but they ARE kept when the
// surrounding block is unambiguously one service (see sortCookieBlocks).
//
// `stampDomain` is the canonical AUTH domain to write onto a domainless cookie when
// re-serializing, so the exported Netscape line is valid (a missing domain column
// makes 3rd-party checkers report a "missing cookie"). These mirror the checker's
// own auth hosts — note Prime's auth cookies live on amazon.com, NOT primevideo.com.
const SERVICE_NAME_HINTS: { id: string; test: (name: string) => boolean; stampDomain: string }[] = [
  { id: "netflix", stampDomain: ".netflix.com", test: (n) => /^(secure)?netflixid$/i.test(n) },
  { id: "crunchyroll", stampDomain: ".crunchyroll.com", test: (n) => /^etp_rt$/i.test(n) },
  {
    id: "prime",
    stampDomain: ".amazon.com",
    test: (n) => /^(at-(main|acb[a-z]{2}|main-av)|sess-at-(main|acb[a-z]{2})|x-main|ubid-(main|acb[a-z]{2}))$/i.test(n),
  },
  { id: "spotify", stampDomain: ".spotify.com", test: (n) => /^sp_(dc|key)$/i.test(n) },
  { id: "twitter", stampDomain: ".twitter.com", test: (n) => /^(auth_token|ct0)$/i.test(n) },
  { id: "facebook", stampDomain: ".facebook.com", test: (n) => /^(c_user|xs|fr)$/i.test(n) },
  { id: "steam", stampDomain: ".steampowered.com", test: (n) => /^steamloginsecure$/i.test(n) },
]
const STAMP_DOMAIN_BY_ID = new Map(SERVICE_NAME_HINTS.map((h) => [h.id, h.stampDomain]))
const SERVICE_BY_ID = new Map(EXTRACTOR_SERVICES.map((s) => [s.id, s]))

// Canonical export domain for a listed service: the precise auth domain when known,
// otherwise the service's primary domain. Used to stamp domainless cookies so every
// serialized Netscape line carries a valid domain column.
function stampDomainFor(serviceId: string): string {
  const explicit = STAMP_DOMAIN_BY_ID.get(serviceId)
  if (explicit) return explicit
  const def = SERVICE_BY_ID.get(serviceId)
  return def ? `.${def.domains[0]}` : ""
}

// Best-effort service for a DOMAINLESS cookie, matched on its distinctive name.
export function serviceForCookieName(name: string): ServiceDef | null {
  const hint = SERVICE_NAME_HINTS.find((h) => h.test(name))
  return hint ? SERVICE_BY_ID.get(hint.id) ?? null : null
}

// Naive registrable domain (eTLD+1) for bucketing UNLISTED hosts in "all" mode.
// Handles the common two-label public suffixes (co.uk, com.au, co.jp, …) so we
// don't split e.g. bbc.co.uk into "co.uk". Good enough for human-friendly sorting.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp",
  "com.au", "net.au", "org.au", "co.nz", "com.br", "com.mx", "co.in",
  "co.kr", "com.tr", "com.sg", "com.hk",
])
export function registrableDomain(host: string): string {
  const parts = host.split(".").filter(Boolean)
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join(".")
  const lastThree = parts.slice(-3).join(".")
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return lastThree
  return lastTwo
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// A friendly label for an account block — prefer an email in the surrounding
// text, else fall back to a generic name the caller will index.
function blockLabel(blockText: string): string | null {
  const m = blockText.match(EMAIL_RE)
  return m ? m[0].toLowerCase() : null
}

export type SortedAccount = {
  // Netscape-serialized cookies for this service from one source account block.
  text: string
  // Email/label when detected, else null (the UI/ZIP assigns "account-N").
  label: string | null
  cookieCount: number
}

export type SortedGroup = {
  id: string
  label: string
  // True for the 18 catalogued services; false for "other" domain buckets.
  listed: boolean
  accounts: SortedAccount[]
  cookieCount: number
}

export type SortResult = {
  groups: SortedGroup[]
  totalCookies: number
  totalAccounts: number
  blockCount: number
  // Listed services that had at least one hit, for a quick summary.
  servicesFound: number
}

const OTHER_PREFIX = "other:"

// Core sorter. Takes the account BLOCKS already extracted from text/files/archives
// (via extractCookieSets(..., "any") / importCookieFiles(..., "any")) and sorts
// every cookie in them by service.
//
// Model: each block is one "account". Within a block we slice the cookies by
// service domain, so one browser export (many services) yields one file per
// service, while a 100-line Netflix combolist yields 100 Netflix files.
//
//  - "listed": keep ONLY the 18 catalogued services, drop everything else.
//  - "all":    additionally bucket unlisted hosts by registrable domain so not a
//              single cookie is lost.
export function sortCookieBlocks(blocks: string[], mode: ExtractMode): SortResult {
  // serviceId/other-key -> { def-ish, dedupe set, accounts }
  const buckets = new Map<
    string,
    { id: string; label: string; listed: boolean; seen: Set<string>; accounts: SortedAccount[]; cookieCount: number }
  >()

  let totalCookies = 0

  function bucketFor(key: string, label: string, listed: boolean) {
    let b = buckets.get(key)
    if (!b) {
      b = { id: key, label, listed, seen: new Set(), accounts: [], cookieCount: 0 }
      buckets.set(key, b)
    }
    return b
  }

  for (const block of blocks) {
    const fmt = detectFormat(block)
    const entries = splitCookiesAndText(block, fmt).entries.filter(isCookieEntry)
    if (entries.length === 0) continue

    // A combolist line / RAW paste is ONE account whose cookies are all domainless.
    // Identify the block's service from the distinctive cookie names present; if
    // exactly one service is implicated, EVERY domainless cookie in the block belongs
    // to it (so multi-cookie services like Steam keep `sessionid` alongside the hinted
    // `steamLoginSecure`, instead of dropping every non-hinted cookie).
    const hintIds = new Set<string>()
    for (const e of entries) {
      if (normalizeHost(e.domain)) continue
      const svc = serviceForCookieName(e.name)
      if (svc) hintIds.add(svc.id)
    }
    const soleDomainlessService = hintIds.size === 1 ? [...hintIds][0] : null

    // Group this block's cookies by destination bucket key.
    const perBucket = new Map<string, CookieEntry[]>()
    const meta = new Map<string, { label: string; listed: boolean }>()

    for (const e of entries) {
      const host = normalizeHost(e.domain)
      // Resolve the service by domain first; for a DOMAINLESS cookie (RAW pastes
      // scattered in text) fall back to its distinctive name, then to the block's
      // sole implicated service, so it's sorted into the right bucket not dropped.
      let svc = host ? serviceForHost(host) : serviceForCookieName(e.name)
      if (!svc && !host && soleDomainlessService) svc = SERVICE_BY_ID.get(soleDomainlessService) ?? null
      if (!host && !svc) continue
      let key: string
      if (svc) {
        key = svc.id
        meta.set(key, { label: svc.label, listed: true })
      } else if (mode === "all") {
        const dom = registrableDomain(host) || host
        key = `${OTHER_PREFIX}${dom}`
        meta.set(key, { label: dom, listed: false })
      } else {
        continue // listed mode drops unlisted cookies
      }
      // Stamp the canonical auth domain (and Secure, since these are HTTPS-only auth
      // cookies) onto any domainless cookie so the serialized Netscape line is valid
      // and imports/checks correctly. Cookies that already carry a domain are left
      // exactly as parsed.
      const entry: CookieEntry = host
        ? e
        : { ...e, domain: stampDomainFor(key) || e.domain, secure: true, path: e.path || "/" }
      const arr = perBucket.get(key) ?? []
      arr.push(entry)
      perBucket.set(key, arr)
    }

    const label = blockLabel(block)

    for (const [key, sliced] of perBucket) {
      const text = serializeCookies(sliced, "NETSCAPE")
      if (!text) continue
      const m = meta.get(key)!
      const b = bucketFor(key, m.label, m.listed)
      // De-duplicate identical per-service slices so the same account isn't
      // emitted twice across overlapping inputs.
      const dedupeKey = text.trim()
      if (b.seen.has(dedupeKey)) continue
      b.seen.add(dedupeKey)
      b.accounts.push({ text, label, cookieCount: sliced.length })
      b.cookieCount += sliced.length
      totalCookies += sliced.length
    }
  }

  const groups: SortedGroup[] = [...buckets.values()]
    .map((b) => ({ id: b.id, label: b.label, listed: b.listed, accounts: b.accounts, cookieCount: b.cookieCount }))
    .sort((a, b) => {
      // Listed services first (in catalogue order), then "other" domains A→Z.
      if (a.listed && b.listed) return (SERVICE_ORDER.get(a.id) ?? 0) - (SERVICE_ORDER.get(b.id) ?? 0)
      if (a.listed !== b.listed) return a.listed ? -1 : 1
      return a.label.localeCompare(b.label)
    })

  const totalAccounts = groups.reduce((n, g) => n + g.accounts.length, 0)
  const servicesFound = groups.filter((g) => g.listed && g.accounts.length > 0).length

  return { groups, totalCookies, totalAccounts, blockCount: blocks.length, servicesFound }
}

// Windows reserved device names — a path component equal to one of these (with or
// without an extension) is rejected by the OS, so we prefix them.
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])

// Produce a single path component that EVERY OS (incl. Windows' built-in ZIP
// extractor) accepts. Windows raises ERROR_INVALID_NAME ("…volume label syntax is
// incorrect") for components that contain reserved characters (< > : " / \ | ? *),
// exceed the 255-char limit, end in a dot/space, or match a reserved device name.
// Account labels here come from arbitrary (sometimes long, URL-encoded) cookie text,
// so we hard-sanitize: keep a safe charset, collapse/trim separators, cap length,
// and guard reserved names. `fallback` is used when nothing usable remains.
function safeSegment(raw: string, fallback: string): string {
  let s = (raw || "")
    .replace(/[^\w.+-]+/g, "_") // anything outside [A-Za-z0-9_.+-] -> underscore
    .replace(/_+/g, "_") // collapse runs of underscores
    .replace(/^[._\s-]+|[._\s-]+$/g, "") // trim leading/trailing dot, underscore, space, dash

  // NTFS caps a component at 255 chars; stay well under to also dodge MAX_PATH on
  // deeply-nested extraction targets. Leave room for the ".txt" extension.
  if (s.length > 120) s = s.slice(0, 120).replace(/[._-]+$/, "")

  if (!s) return fallback
  if (WINDOWS_RESERVED.has(s.toLowerCase())) s = `_${s}`
  return s
}

// Folder-safe name for a service group inside the ZIP.
export function groupFolderName(group: SortedGroup): string {
  if (group.listed) return safeSegment(group.label, "service")
  // "other" domains keep their domain as folder, namespaced under _Other.
  return `_Other/${safeSegment(group.label, "domain")}`
}

// Per-account .txt filename within a service folder.
export function accountTxtName(account: SortedAccount, index: number): string {
  const base = account.label ? safeSegment(account.label, `account-${index + 1}`) : `account-${index + 1}`
  return `${base}.txt`
}
