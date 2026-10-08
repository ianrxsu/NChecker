import { describe, it, expect } from "vitest"
import {
  isPlanExpired,
  isAliveResult,
  findJsonRegion,
  detectFormat,
  scanNetscapeRecords,
  lineHasCookies,
  parseCookies,
  serializeCookies,
  splitCookiesAndText,
  analyzeCookie,
  prepareCookieForCheck,
  isCookieEntry,
  hasNetflixAuth,
  hasPrimeAuth,
  hasCrunchyrollAuth,
  cleanCookieSet,
  extractCookieSets,
  setLabel,
  prettyKey,
  sanitizeFileName,
  accountFileName,
  accountCountry,
  accountPlan,
  runPool,
  cookieToCookieEditorJson,
  type CookieEntry,
} from "./cookie-utils"

const RAW = "NetflixId=abc123; SecureNetflixId=def456; flwssn=ghi789"
const JSON_COOKIES = JSON.stringify([
  { name: "NetflixId", value: "abc123", domain: ".netflix.com", path: "/", secure: true, expirationDate: 1700000000 },
  { name: "SecureNetflixId", value: "def456" },
])
const NETSCAPE =
  ".netflix.com\tTRUE\t/\tTRUE\t1700000000\tNetflixId\tabc123\n" +
  ".netflix.com\tTRUE\t/\tTRUE\t1700000000\tSecureNetflixId\tdef456"

describe("isPlanExpired", () => {
  it("returns false for undefined or active plans", () => {
    expect(isPlanExpired(undefined)).toBe(false)
    expect(isPlanExpired("Premium 4K")).toBe(false)
    expect(isPlanExpired("Standard with ads")).toBe(false)
  })

  it("detects expired / cancelled / inactive plans (case-insensitive)", () => {
    expect(isPlanExpired("Expired")).toBe(true)
    expect(isPlanExpired("EXPIRE")).toBe(true)
    expect(isPlanExpired("Cancelled")).toBe(true)
    expect(isPlanExpired("canceled")).toBe(true)
    expect(isPlanExpired("Account inactive")).toBe(true)
  })
})

describe("isAliveResult", () => {
  it("is alive only when valid and not expired", () => {
    expect(isAliveResult({ valid: true, plan: "Premium" })).toBe(true)
    expect(isAliveResult({ valid: true, plan: "Expired" })).toBe(false)
    expect(isAliveResult({ valid: false, plan: "Premium" })).toBe(false)
    expect(isAliveResult({ valid: true })).toBe(true)
  })
})

describe("findJsonRegion", () => {
  it("extracts a JSON array embedded in surrounding text", () => {
    const text = `junk before\n${JSON_COOKIES}\njunk after`
    const region = findJsonRegion(text)
    expect(region).not.toBeNull()
    expect(region?.before).toContain("junk before")
    expect(region?.after).toContain("junk after")
    expect(JSON.parse(region!.region)).toHaveLength(2)
  })

  it("extracts a JSON object region", () => {
    const region = findJsonRegion('prefix {"a":1} suffix')
    expect(region).not.toBeNull()
    expect(JSON.parse(region!.region)).toEqual({ a: 1 })
  })

  it("returns null when there is no valid JSON", () => {
    expect(findJsonRegion("just plain text")).toBeNull()
    expect(findJsonRegion("name=value; other=thing")).toBeNull()
  })
})

describe("detectFormat", () => {
  it("returns RAW for empty input", () => {
    expect(detectFormat("")).toBe("RAW")
    expect(detectFormat("   ")).toBe("RAW")
  })

  it("detects JSON, NETSCAPE, and RAW", () => {
    expect(detectFormat(JSON_COOKIES)).toBe("JSON")
    expect(detectFormat(NETSCAPE)).toBe("NETSCAPE")
    expect(detectFormat(RAW)).toBe("RAW")
  })
})

describe("lineHasCookies", () => {
  it("ignores comments and blank lines", () => {
    expect(lineHasCookies("# comment", "NETSCAPE")).toBe(false)
    expect(lineHasCookies("// comment", "RAW")).toBe(false)
    expect(lineHasCookies("   ", "RAW")).toBe(false)
  })

  it("detects netscape and raw cookie lines", () => {
    expect(lineHasCookies(".netflix.com\tTRUE\t/\tTRUE\t0\tNetflixId\tabc", "NETSCAPE")).toBe(true)
    expect(lineHasCookies("NetflixId=abc123", "RAW")).toBe(true)
    expect(lineHasCookies("Email: user@example.com", "RAW")).toBe(false)
  })
})

describe("parseCookies", () => {
  it("returns [] for empty input", () => {
    expect(parseCookies("", "RAW")).toEqual([])
  })

  it("parses RAW cookies", () => {
    const entries = parseCookies(RAW, "RAW")
    expect(entries).toHaveLength(3)
    // RAW headers carry no domain, so it's left empty ("unknown") rather than
    // guessed as ".netflix.com" (which leaked cross-service in the checker).
    expect(entries[0]).toMatchObject({ name: "NetflixId", value: "abc123", domain: "" })
  })

  it("parses JSON cookies with default fallbacks", () => {
    const entries = parseCookies(JSON_COOKIES, "JSON")
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ name: "NetflixId", value: "abc123", secure: true, expiry: 1700000000 })
    expect(entries[1]).toMatchObject({ name: "SecureNetflixId", domain: ".netflix.com", path: "/", expiry: 0 })
  })

  it("parses a JSON object map into name/value entries", () => {
    const entries = parseCookies('{"NetflixId":"abc","flwssn":"xyz"}', "JSON")
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.name)).toEqual(["NetflixId", "flwssn"])
  })

  it("returns [] for malformed JSON", () => {
    expect(parseCookies("{not json", "JSON")).toEqual([])
  })

  it("parses NETSCAPE rows", () => {
    const entries = parseCookies(NETSCAPE, "NETSCAPE")
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ name: "NetflixId", value: "abc123", secure: true, expiry: 1700000000 })
  })
})

describe("serializeCookies", () => {
  const entries: CookieEntry[] = [
    { name: "NetflixId", value: "abc", domain: ".netflix.com", path: "/", secure: true, expiry: 123 },
    { name: "flwssn", value: "xyz", domain: ".netflix.com", path: "/", secure: false, expiry: 0 },
  ]

  it("returns empty string for no entries", () => {
    expect(serializeCookies([], "RAW")).toBe("")
  })

  it("serializes RAW", () => {
    expect(serializeCookies(entries, "RAW")).toBe("NetflixId=abc; flwssn=xyz")
  })

  it("serializes NETSCAPE with tab columns", () => {
    const out = serializeCookies(entries, "NETSCAPE").split("\n")
    expect(out[0].split("\t")).toEqual([".netflix.com", "TRUE", "/", "TRUE", "123", "NetflixId", "abc"])
    expect(out[1].split("\t")[3]).toBe("FALSE")
  })

  it("round-trips RAW through parse + serialize", () => {
    const parsed = parseCookies(RAW, "RAW")
    expect(serializeCookies(parsed, "RAW")).toBe(RAW)
  })

  it("serializes JSON with expirationDate key", () => {
    const parsed = JSON.parse(serializeCookies(entries, "JSON"))
    expect(parsed[0]).toMatchObject({ name: "NetflixId", value: "abc", expirationDate: 123 })
  })
})

describe("splitCookiesAndText", () => {
  it("separates cookies from extra text (RAW)", () => {
    const text = "Email: user@example.com\nNetflixId=abc123\nPassword: secret"
    const { entries, extra } = splitCookiesAndText(text, "RAW")
    expect(entries.map((e) => e.name)).toContain("NetflixId")
    expect(extra).toContain("Email")
    expect(extra).toContain("Password")
  })

  it("extracts a JSON region and preserves surrounding text", () => {
    const text = `note\n${JSON_COOKIES}\nfooter`
    const { entries, extra } = splitCookiesAndText(text, "JSON")
    expect(entries).toHaveLength(2)
    expect(extra).toContain("note")
    expect(extra).toContain("footer")
  })

  it("returns empty for blank input", () => {
    expect(splitCookiesAndText("", "RAW")).toEqual({ entries: [], extra: "" })
  })
})

describe("analyzeCookie", () => {
  it("reports format, totals, and netflix id presence", () => {
    const a = analyzeCookie(RAW)
    expect(a.format).toBe("RAW")
    expect(a.total).toBe(3)
    expect(a.netflixId).toBe(true)
    expect(a.secureNetflixId).toBe(true)
  })

  it("handles empty input", () => {
    expect(analyzeCookie("")).toEqual({
      format: "RAW",
      total: 0,
      netflixId: false,
      secureNetflixId: false,
      primeAuth: false,
      primeSession: false,
      crunchyrollAuth: false,
    })
  })
})

describe("isCookieEntry", () => {
  const base = { domain: ".netflix.com", path: "/", secure: false, expiry: 0 }
  it("accepts clean cookie pairs", () => {
    expect(isCookieEntry({ ...base, name: "NetflixId", value: "abc123" })).toBe(true)
  })
  it("rejects junk names, empty or spaced values", () => {
    expect(isCookieEntry({ ...base, name: "user@example.com", value: "x" })).toBe(false)
    expect(isCookieEntry({ ...base, name: "NetflixId", value: "" })).toBe(false)
    expect(isCookieEntry({ ...base, name: "NetflixId", value: "has space" })).toBe(false)
  })
})

describe("hasNetflixAuth", () => {
  it("is true when a (Secure)NetflixId cookie exists", () => {
    expect(hasNetflixAuth(parseCookies(RAW, "RAW"))).toBe(true)
    expect(hasNetflixAuth(parseCookies("flwssn=abc", "RAW"))).toBe(false)
  })
})

// Realistic, full-length token values (real session cookies are long, high-entropy
// blobs — never short placeholders or booleans).
const PRIME_TOKEN = "Atza|IwEBIABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij"
const CR_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwidCI6MTIzNDU2Nzg5MH0.aBcDeFgHiJkLmNoP"

describe("hasPrimeAuth (value-aware)", () => {
  it("is true for a real Amazon auth token", () => {
    expect(hasPrimeAuth(parseCookies(`at-main=${PRIME_TOKEN}`, "RAW"))).toBe(true)
    expect(hasPrimeAuth(parseCookies(`x-main=${PRIME_TOKEN}`, "RAW"))).toBe(true)
  })
  it("rejects junk/placeholder values that merely share the name", () => {
    expect(hasPrimeAuth(parseCookies("at-main=true", "RAW"))).toBe(false)
    expect(hasPrimeAuth(parseCookies("x-main=1", "RAW"))).toBe(false)
    expect(hasPrimeAuth(parseCookies("at-main=short", "RAW"))).toBe(false)
  })
  it("does not qualify on the weak locale-only cookie", () => {
    expect(hasPrimeAuth(parseCookies("lc-main=en_US", "RAW"))).toBe(false)
  })
  it("is false for Netflix / Crunchyroll cookies", () => {
    expect(hasPrimeAuth(parseCookies(RAW, "RAW"))).toBe(false)
    expect(hasPrimeAuth(parseCookies(`etp_rt=${CR_TOKEN}`, "RAW"))).toBe(false)
  })
})

describe("cookieToCookieEditorJson (Prime imports)", () => {
  it("preserves a complete Prime JSON export larger than the former 8 KiB limit", () => {
    const authValue = `${PRIME_TOKEN}${"A".repeat(2_000)}`
    const cookies = [
      {
        name: "at-main",
        value: authValue,
        domain: ".amazon.com",
        path: "/",
        secure: true,
        expirationDate: 1_900_000_000,
      },
      ...Array.from({ length: 90 }, (_, index) => ({
        name: `prime-cookie-${index}`,
        value: `value-${index}-${"x".repeat(90)}`,
        domain: index % 2 === 0 ? ".amazon.com" : ".primevideo.com",
        path: "/",
        secure: true,
        expirationDate: 1_900_000_000,
      })),
    ]
    const source = JSON.stringify(cookies)
    expect(source.length).toBeGreaterThan(8_192)

    const output = cookieToCookieEditorJson(source, "prime")
    const parsed = JSON.parse(output) as Array<{ name: string; value: string; domain: string }>
    expect(parsed.length).toBe(cookies.length)
    expect(parsed.find((cookie) => cookie.name === "at-main")).toMatchObject({
      value: authValue,
      domain: ".amazon.com",
    })
    expect(parsed.every((cookie) => cookie.domain.includes("amazon") || cookie.domain.includes("primevideo"))).toBe(true)
  })

  it("returns an explicit empty JSON array for malformed or truncated Prime JSON", () => {
    const truncated = `[{"name":"at-main","value":"${PRIME_TOKEN}","domain":".amazon.com"`
    expect(cookieToCookieEditorJson(truncated, "prime")).toBe("[]")
  })
})

describe("hasCrunchyrollAuth (value-aware)", () => {
  it("is true for a real etp_rt refresh token", () => {
    expect(hasCrunchyrollAuth(parseCookies(`etp_rt=${CR_TOKEN}`, "RAW"))).toBe(true)
  })
  it("rejects junk/placeholder values that merely share the name", () => {
    expect(hasCrunchyrollAuth(parseCookies("etp_rt=1", "RAW"))).toBe(false)
    expect(hasCrunchyrollAuth(parseCookies("etp_rt=null", "RAW"))).toBe(false)
    expect(hasCrunchyrollAuth(parseCookies("etp_rt=tooshort", "RAW"))).toBe(false)
  })
  it("is false for Netflix / Prime cookies", () => {
    expect(hasCrunchyrollAuth(parseCookies(RAW, "RAW"))).toBe(false)
    expect(hasCrunchyrollAuth(parseCookies(`at-main=${PRIME_TOKEN}`, "RAW"))).toBe(false)
  })
})

describe("extractCookieSets (service-specific, mixed dump)", () => {
  // One messy paste containing a real account for each service plus noise.
  const MIXED = [
    "random note line",
    `NetflixId=abc123; SecureNetflixId=def456`,
    `at-main=${PRIME_TOKEN}; session-id=123-456`,
    `etp_rt=${CR_TOKEN}; c_locale=en-US`,
    `etp_rt=1`, // junk: name only, placeholder value
  ].join("\n")

  it("netflix extracts only the Netflix line", () => {
    const sets = extractCookieSets(MIXED, "netflix")
    expect(sets).toHaveLength(1)
    expect(sets[0]).toContain("NetflixId")
  })
  it("prime extracts only the Amazon line", () => {
    const sets = extractCookieSets(MIXED, "prime")
    expect(sets).toHaveLength(1)
    expect(sets[0]).toContain("at-main")
  })
  it("crunchyroll extracts only the real etp_rt line (ignores the junk one)", () => {
    const sets = extractCookieSets(MIXED, "crunchyroll")
    expect(sets).toHaveLength(1)
    expect(sets[0]).toContain("etp_rt")
  })
})

describe("extractCookieSets (multi-domain cookies.txt slicing)", () => {
  const tab = (domain: string, name: string, value: string) =>
    `${domain}\tTRUE\t/\tTRUE\t1799999999\t${name}\t${value}`

  // A real-world export: one account's worth of cookies spread across many
  // unrelated sites, including a genuine Crunchyroll session (etp_rt).
  const REAL_DUMP = [
    "# Netscape HTTP Cookie File",
    tab(".youtube.com", "VISITOR_INFO1_LIVE", "-iIcM0dLbIgABCDEF"),
    tab(".discord.com", "__dcfduid", "9f8a7b6c5d4e3f2a1b0cABCDEF123456"),
    tab(".crunchyroll.com", "__cf_bm", "jsabcdefghijklmnopqrstuvwxyz0123456789"),
    tab(".crunchyroll.com", "etp_rt", CR_TOKEN),
    tab(".yandex.com", "yandexuid", "4242617961779369875"),
    tab(".amazon.com", "at-main", PRIME_TOKEN),
  ].join("\n")

  it("crunchyroll keeps only crunchyroll.com cookies (no discord/youtube/yandex/amazon)", () => {
    const sets = extractCookieSets(REAL_DUMP, "crunchyroll")
    expect(sets).toHaveLength(1)
    const set = sets[0]
    expect(set).toContain("etp_rt")
    expect(set).toContain("crunchyroll.com")
    expect(set).not.toContain("discord")
    expect(set).not.toContain("youtube")
    expect(set).not.toContain("yandex")
    expect(set).not.toContain("amazon")
    expect(set).not.toContain("at-main")
  })

  it("prime keeps only amazon cookies from the same dump", () => {
    const sets = extractCookieSets(REAL_DUMP, "prime")
    expect(sets).toHaveLength(1)
    expect(sets[0]).toContain("at-main")
    expect(sets[0]).not.toContain("etp_rt")
    expect(sets[0]).not.toContain("discord")
  })

  it("a dump with NO service auth cookie (only __cf_bm etc.) is not detected", () => {
    const NOISE = [
      "# Netscape HTTP Cookie File",
      tab(".youtube.com", "VISITOR_INFO1_LIVE", "-iIcM0dLbIgABCDEF"),
      tab(".crunchyroll.com", "__cf_bm", "jsabcdefghijklmnopqrstuvwxyz0123456789"),
      tab(".discord.com", "__dcfduid", "9f8a7b6c5d4e3f2a1b0cABCDEF123456"),
    ].join("\n")
    expect(extractCookieSets(NOISE, "crunchyroll")).toHaveLength(0)
    expect(extractCookieSets(NOISE, "netflix")).toHaveLength(0)
    expect(extractCookieSets(NOISE, "prime")).toHaveLength(0)
  })
})

describe("extractCookieSets (full browser export — scattered cookies, none left behind)", () => {
  const tab = (domain: string, name: string, value: string) =>
    `${domain}\tTRUE\t/\tTRUE\t1799999999\t${name}\t${value}`

  // A realistic whole-browser cookies.txt: ONE account's Crunchyroll cookies are
  // scattered far apart, interleaved with many unrelated sites — and crucially,
  // generic names (__cf_bm, _ga, sessionid) repeat across domains, which used to
  // shred the single account into fragments and drop scattered service cookies.
  const BROWSER_EXPORT = [
    "# Netscape HTTP Cookie File",
    tab(".google.com", "_ga", "GA1.2.111111111.1700000000"),
    tab(".crunchyroll.com", "__cf_bm", "cfbmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    tab(".youtube.com", "VISITOR_INFO1_LIVE", "abcDEF123456"),
    tab(".youtube.com", "__cf_bm", "ytcfbmZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
    tab(".crunchyroll.com", "c_locale", "enUS"),
    tab(".doubleclick.net", "IDE", "AHWqTUmXyZ0123456789abcdefghij"),
    tab(".discord.com", "sessionid", "discordsess0123456789abcdefghij"),
    tab(".crunchyroll.com", "etp_rt", CR_TOKEN),
    tab(".reddit.com", "_ga", "GA1.2.999999999.1700000000"),
    tab(".crunchyroll.com", "device_id", "11111111-2222-3333-4444-555555555555"),
    tab(".facebook.com", "sessionid", "fbsess0123456789abcdefghij"),
    tab(".crunchyroll.com", "session_id", "ffffffffeeeeeeeeddddddddcccccccc"),
  ].join("\n")

  it("gathers EVERY crunchyroll.com cookie into one account, dropping all other sites", () => {
    const sets = extractCookieSets(BROWSER_EXPORT, "crunchyroll")
    expect(sets).toHaveLength(1)
    const set = sets[0]
    // All five scattered Crunchyroll cookies survive — none left behind.
    expect(set).toContain("__cf_bm")
    expect(set).toContain("c_locale")
    expect(set).toContain("etp_rt")
    expect(set).toContain("device_id")
    expect(set).toContain("session_id")
    // Zero cross-site contamination.
    for (const junk of ["google", "youtube", "doubleclick", "discord", "reddit", "facebook"]) {
      expect(set).not.toContain(junk)
    }
  })

  it("separates two Crunchyroll accounts in one export (auth cookie repeats)", () => {
    const TWO = [
      "# Netscape HTTP Cookie File",
      tab(".crunchyroll.com", "__cf_bm", "acct1cfbmaaaaaaaaaaaaaaaaaaaaaaaa"),
      tab(".youtube.com", "_ga", "GA1.2.111.170"),
      tab(".crunchyroll.com", "etp_rt", CR_TOKEN),
      tab(".crunchyroll.com", "__cf_bm", "acct2cfbmbbbbbbbbbbbbbbbbbbbbbbbb"),
      tab(".crunchyroll.com", "etp_rt", `${CR_TOKEN}.second`),
    ].join("\n")
    const sets = extractCookieSets(TWO, "crunchyroll")
    expect(sets).toHaveLength(2)
    expect(sets.every((s) => s.includes("etp_rt"))).toBe(true)
  })
})

describe("extractCookieSets (tolerant JSON shapes — nothing left behind)", () => {
  const NF = "v%3D2%26ct%3D" + "b".repeat(60)
  const AM = "Atza|" + "c".repeat(60)

  it("NDJSON: one cookie object per line (no array, no blank lines)", () => {
    const nd = [
      `{"name":"etp_rt","value":"${CR_TOKEN}","domain":".crunchyroll.com"}`,
      `{"name":"c_locale","value":"en-US","domain":".crunchyroll.com"}`,
    ].join("\n")
    expect(extractCookieSets(nd, "crunchyroll")).toHaveLength(1)
  })

  it("multiple concatenated JSON arrays become separate accounts", () => {
    const concat = [
      `[{"name":"etp_rt","value":"${CR_TOKEN}1","domain":".crunchyroll.com"}]`,
      `[{"name":"etp_rt","value":"${CR_TOKEN}2","domain":".crunchyroll.com"}]`,
    ].join("\n")
    expect(extractCookieSets(concat, "crunchyroll")).toHaveLength(2)
  })

  it("a single cookie object (not wrapped in an array) is parsed", () => {
    const obj = `{"name":"etp_rt","value":"${CR_TOKEN}","domain":".crunchyroll.com"}`
    expect(extractCookieSets(obj, "crunchyroll")).toHaveLength(1)
  })

  it("cookie objects nested inside a wrapper { url, cookies: [...] } are found", () => {
    const wrapped = JSON.stringify({
      url: "https://crunchyroll.com",
      cookies: [{ name: "etp_rt", value: CR_TOKEN, domain: ".crunchyroll.com" }],
    })
    expect(extractCookieSets(wrapped, "crunchyroll")).toHaveLength(1)
  })

  it("tolerates the `hostKey` domain spelling used by some exporters", () => {
    const hk = `[{"name":"etp_rt","value":"${CR_TOKEN}","hostKey":".crunchyroll.com"}]`
    expect(extractCookieSets(hk, "crunchyroll")).toHaveLength(1)
  })

  it("works the same for Netflix and Prime (NDJSON / embedded-in-noise)", () => {
    const nfNd = [
      `{"name":"NetflixId","value":"${NF}","domain":".netflix.com"}`,
      `{"name":"SecureNetflixId","value":"${NF}x","domain":".netflix.com"}`,
    ].join("\n")
    expect(extractCookieSets(nfNd, "netflix")).toHaveLength(1)

    const amNoise = `noisy header\n{"name":"at-main","value":"${AM}","domain":".amazon.com"}\nfooter`
    expect(extractCookieSets(amNoise, "prime")).toHaveLength(1)
  })

  it("still rejects junk values and the wrong service inside JSON", () => {
    expect(
      extractCookieSets(`{"name":"etp_rt","value":"deleted","domain":".crunchyroll.com"}`, "crunchyroll"),
    ).toHaveLength(0)
    expect(
      extractCookieSets(`{"name":"NetflixId","value":"${NF}","domain":".netflix.com"}`, "crunchyroll"),
    ).toHaveLength(0)
  })
})

describe("cleanCookieSet", () => {
  it("keeps only real cookies and requires a netflix auth cookie", () => {
    const dirty = "Email: a@b.com\nNetflixId=abc123\nflwssn=xyz\nrandom note"
    expect(cleanCookieSet(dirty)).toBe("NetflixId=abc123; flwssn=xyz")
  })
  it("returns null without a netflix auth cookie", () => {
    expect(cleanCookieSet("flwssn=xyz; other=val")).toBeNull()
  })
})

describe("extractCookieSets", () => {
  it("treats each combo-list line as its own account", () => {
    const text = "NetflixId=a1; flwssn=b1\nNetflixId=a2; flwssn=b2"
    const sets = extractCookieSets(text)
    expect(sets).toHaveLength(2)
    expect(sets[0]).toContain("NetflixId=a1")
    expect(sets[1]).toContain("NetflixId=a2")
  })

  it("ignores lines without netflix auth cookies", () => {
    const text = "flwssn=only\nNetflixId=a1; flwssn=b1"
    const sets = extractCookieSets(text)
    expect(sets).toHaveLength(1)
  })

  it("treats a JSON block as one set, preserving JSON format", () => {
    const sets = extractCookieSets(JSON_COOKIES)
    expect(sets).toHaveLength(1)
    const parsed = JSON.parse(sets[0])
    expect(parsed.find((c: { name: string }) => c.name === "NetflixId")?.value).toBe("abc123")
  })

  it("returns [] for blank input", () => {
    expect(extractCookieSets("   ")).toEqual([])
  })
})

// A realistic "DEADFLIX" style dump: two accounts where each account's banner
// text AND its space-separated Netscape cookies are flattened onto one line,
// with only noise lines ("Entering", dates) between accounts — no blank lines.
const MASHED_DUMP = [
  "Entering",
  "Netflix",
  "ENTERING",
  "═══ NETFLIX ACCOUNT DETAILS – Email: a@gmail.com – Country: PH ═══ " +
    ".netflix.com TRUE / FALSE 1806565127 nfvdid AAA111 " +
    ".netflix.com TRUE / TRUE 1810727405 NetflixId CT_AAA " +
    ".netflix.com TRUE / TRUE 1810727405 SecureNetflixId SEC_AAA " +
    ".netflix.com TRUE / FALSE 1810745241 OptanonConsent isGpcEnabled=0&groups=C0001",
  "25 Jun 26",
  "Entering",
  "Netflix",
  "ENTERING",
  "═══ NETFLIX ACCOUNT DETAILS – Email: b@gmail.com – Country: PH ═══ " +
    ".netflix.com TRUE / FALSE 1792605264 nfvdid BBB222 " +
    ".netflix.com TRUE / TRUE 1806167156 NetflixId CT_BBB " +
    ".netflix.com TRUE / TRUE 1806167156 SecureNetflixId SEC_BBB",
  "25 Jun 26",
].join("\n")

describe("scanNetscapeRecords", () => {
  it("scans tab-separated rows", () => {
    const recs = scanNetscapeRecords(NETSCAPE)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ name: "NetflixId", value: "abc123", secure: true })
  })

  it("scans space-separated and multi-record (mashed) lines", () => {
    const line =
      ".netflix.com TRUE / FALSE 123 nfvdid AAA .netflix.com TRUE / TRUE 456 NetflixId BBB"
    const recs = scanNetscapeRecords(line)
    expect(recs).toHaveLength(2)
    expect(recs.map((r) => r.name)).toEqual(["nfvdid", "NetflixId"])
    expect(recs[1]).toMatchObject({ value: "BBB", secure: true, expiry: 456 })
  })

  it("ignores surrounding banner/label noise", () => {
    const recs = scanNetscapeRecords(
      "═══ NETFLIX ACCOUNT DETAILS – Email: x@y.com ═══ .netflix.com TRUE / TRUE 1 NetflixId ZZZ",
    )
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ name: "NetflixId", value: "ZZZ" })
  })
})

describe("detectFormat (space-separated netscape)", () => {
  it("detects flattened/space-separated netscape dumps as NETSCAPE", () => {
    expect(detectFormat(MASHED_DUMP)).toBe("NETSCAPE")
    expect(detectFormat(".netflix.com TRUE / TRUE 1 NetflixId ZZZ")).toBe("NETSCAPE")
  })
})

describe("extractCookieSets (robust multi-account)", () => {
  it("splits a banner-delimited mashed dump into one set per account", () => {
    const sets = extractCookieSets(MASHED_DUMP)
    expect(sets).toHaveLength(2)
    expect(sets[0]).toContain("NetflixId")
    expect(sets[0]).toContain("CT_AAA")
    expect(sets[1]).toContain("CT_BBB")
    // Noise (banners, emails, dates) must not leak into the cookie sets.
    expect(sets[0]).not.toContain("Email")
    expect(sets[0]).not.toContain("ENTERING")
  })

  it("splits space-separated accounts with no banners via repeating-name grouping", () => {
    const noBanner =
      ".netflix.com TRUE / FALSE 1 nfvdid AAA .netflix.com TRUE / TRUE 2 NetflixId CT_AAA " +
      ".netflix.com TRUE / FALSE 3 nfvdid BBB .netflix.com TRUE / TRUE 4 NetflixId CT_BBB"
    const sets = extractCookieSets(noBanner)
    expect(sets).toHaveLength(2)
    expect(sets[0]).toContain("CT_AAA")
    expect(sets[1]).toContain("CT_BBB")
  })

  it("drops accounts that lack a netflix auth cookie", () => {
    const dump =
      ".netflix.com TRUE / FALSE 1 nfvdid AAA .netflix.com TRUE / FALSE 2 OptanonConsent x=1 " +
      ".netflix.com TRUE / FALSE 3 nfvdid BBB .netflix.com TRUE / TRUE 4 NetflixId CT_BBB"
    const sets = extractCookieSets(dump)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toContain("CT_BBB")
  })
})

describe("setLabel", () => {
  it("prefers the netflix id cookie and truncates", () => {
    const label = setLabel("NetflixId=abcdefghijklmnopqrstuvwxyz; flwssn=z")
    expect(label.startsWith("NetflixId=abcdefghijklmn")).toBe(true)
    expect(label).toContain("…")
  })
})

describe("prettyKey", () => {
  it("maps known raw keys", () => {
    expect(prettyKey("x_mail")).toBe("Email")
    expect(prettyKey("x_tier")).toBe("Plan")
  })
  it("humanizes unknown keys", () => {
    expect(prettyKey("x_some_field")).toBe("Some Field")
    expect(prettyKey("custom-key")).toBe("Custom Key")
  })
})

describe("sanitizeFileName", () => {
  it("replaces illegal characters and falls back", () => {
    expect(sanitizeFileName('a/b:c*d?"<>|e')).toBe("a_b_c_d_e")
    expect(sanitizeFileName("")).toBe("UNKNOWN")
    expect(sanitizeFileName("   ", "fallback")).toBe("fallback")
  })
})

describe("account file/folder helpers", () => {
  it("builds [PLAN][EMAIL].txt file names", () => {
    expect(accountFileName({ valid: true, plan: "Premium", email: "a@b.com" })).toBe("[Premium][a@b.com].txt")
    expect(accountFileName(undefined)).toBe("[UNKNOWN][account].txt")
  })
  it("derives country and plan folders", () => {
    expect(accountCountry({ valid: true, countryCode: "US" })).toBe("US")
    expect(accountCountry(undefined)).toBe("UNKNOWN")
    expect(accountPlan({ valid: true, plan: "Premium" })).toBe("Premium")
  })
})

describe("prepareCookieForCheck", () => {
  it("prefers netflix auth cookies and reports total count", () => {
    const { cookie, count } = prepareCookieForCheck(RAW)
    expect(cookie).toBe("NetflixId=abc123; SecureNetflixId=def456")
    expect(count).toBe(3)
  })
  it("returns empty when no cookies are present", () => {
    expect(prepareCookieForCheck("just text")).toEqual({ cookie: "", count: 0 })
  })
})


describe("runPool", () => {
  it("processes every item exactly once with bounded concurrency", async () => {
    const seen: number[] = []
    let active = 0
    let maxActive = 0
    await runPool(10, 3, async (i) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      seen.push(i)
      active--
    })
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it("handles zero items", async () => {
    let calls = 0
    await runPool(0, 4, async () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})
