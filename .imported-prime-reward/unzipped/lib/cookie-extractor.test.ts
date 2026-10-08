import { describe, it, expect } from "vitest"
import { extractCookieSets } from "@/lib/cookie-utils"
import {
  sortCookieBlocks,
  serviceForHost,
  registrableDomain,
  groupFolderName,
  accountTxtName,
} from "@/lib/cookie-extractor"

const tab = (d: string, n: string, v: string) => `${d}\tTRUE\t/\tTRUE\t1799999999\t${n}\t${v}`
const NF = "v%3D2%26ct%3D" + "b".repeat(50)
const CR = "eyJhbGciOiJIUzI1NiJ9." + "a".repeat(40) + ".sig"
const long = (p: string) => p + "x".repeat(40)

describe("serviceForHost", () => {
  it("maps known hosts (incl. subdomains) to services", () => {
    expect(serviceForHost("netflix.com")?.id).toBe("netflix")
    expect(serviceForHost("www.netflix.com")?.id).toBe("netflix")
    expect(serviceForHost("crunchyroll.com")?.id).toBe("crunchyroll")
    expect(serviceForHost("open.spotify.com")?.id).toBe("spotify")
    expect(serviceForHost("x.com")?.id).toBe("twitter")
    expect(serviceForHost("chatgpt.com")?.id).toBe("chatgpt")
    expect(serviceForHost("claude.ai")?.id).toBe("claude")
    expect(serviceForHost("hotstar.com")?.id).toBe("disneyhotstar")
  })
  it("matches Amazon regional TLDs as Prime", () => {
    expect(serviceForHost("amazon.com")?.id).toBe("prime")
    expect(serviceForHost("amazon.co.uk")?.id).toBe("prime")
    expect(serviceForHost("www.primevideo.com")?.id).toBe("prime")
  })
  it("returns null for unknown hosts", () => {
    expect(serviceForHost("reddit.com")).toBeNull()
    expect(serviceForHost("example.org")).toBeNull()
  })
})

describe("registrableDomain", () => {
  it("reduces hosts to eTLD+1", () => {
    expect(registrableDomain("cdn.reddit.com")).toBe("reddit.com")
    expect(registrableDomain("a.b.example.org")).toBe("example.org")
  })
  it("keeps two-label public suffixes intact", () => {
    expect(registrableDomain("foo.bbc.co.uk")).toBe("bbc.co.uk")
  })
})

describe("sortCookieBlocks", () => {
  // ONE browser export: cookies for many services scattered + an unlisted site.
  const browser = [
    "# Netscape HTTP Cookie File",
    "user@gmail.com:hunter2",
    tab(".netflix.com", "NetflixId", NF),
    tab(".spotify.com", "sp_dc", long("spdc")),
    tab(".crunchyroll.com", "etp_rt", CR),
    tab(".reddit.com", "reddit_session", long("r")),
    tab(".x.com", "auth_token", long("a")),
    tab(".steamcommunity.com", "steamLoginSecure", long("s")),
  ].join("\n")
  const blocks = extractCookieSets(browser, "any")

  it("listed mode splits one export into one file per known service, dropping unlisted", () => {
    const r = sortCookieBlocks(blocks, "listed")
    const ids = r.groups.map((g) => g.id)
    expect(ids).toContain("netflix")
    expect(ids).toContain("spotify")
    expect(ids).toContain("crunchyroll")
    expect(ids).toContain("twitter")
    expect(ids).toContain("steam")
    expect(ids).not.toContain("other:reddit.com") // dropped in listed mode
    expect(r.groups.every((g) => g.accounts.length === 1)).toBe(true)
    expect(r.servicesFound).toBe(5)
  })

  it("everything mode keeps unlisted hosts grouped by domain", () => {
    const r = sortCookieBlocks(blocks, "all")
    const other = r.groups.find((g) => !g.listed)
    expect(other?.label).toBe("reddit.com")
    expect(other?.accounts).toHaveLength(1)
    // listed services still come first
    expect(r.groups[0].listed).toBe(true)
  })

  it("falls back to a generic label when extraction has stripped the email banner", () => {
    // extractCookieSets returns cookie-only sets (surrounding text like the email
    // line is removed), so the per-account label is null and the ZIP uses account-N.
    const r = sortCookieBlocks(blocks, "listed")
    expect(r.groups.find((g) => g.id === "netflix")?.accounts[0].label).toBeNull()
  })

  it("uses an inline email as the label when it survives in the block text", () => {
    // A raw block that still carries the email alongside the cookie keeps it.
    const r = sortCookieBlocks(["user@gmail.com\n" + tab(".netflix.com", "NetflixId", NF)], "listed")
    expect(r.groups.find((g) => g.id === "netflix")?.accounts[0].label).toBe("user@gmail.com")
  })

  it("a combolist of N single-line accounts yields N files for that service", () => {
    const combo = Array.from({ length: 5 }, (_, i) => tab(".netflix.com", "NetflixId", NF + i)).join("\n")
    const r = sortCookieBlocks(extractCookieSets(combo, "any"), "listed")
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].id).toBe("netflix")
    expect(r.groups[0].accounts).toHaveLength(5)
  })

  it("de-duplicates identical per-service account slices", () => {
    const dupe = [browser, browser].join("\n\n")
    const r = sortCookieBlocks(extractCookieSets(dupe, "any"), "listed")
    expect(r.groups.find((g) => g.id === "netflix")?.accounts).toHaveLength(1)
  })
})

describe("ZIP naming helpers", () => {
  it("listed services use a flat folder, unlisted nest under _Other", () => {
    const r = sortCookieBlocks(
      extractCookieSets(
        [tab(".netflix.com", "NetflixId", NF), tab(".reddit.com", "reddit_session", long("r"))].join("\n"),
        "any",
      ),
      "all",
    )
    const nf = r.groups.find((g) => g.id === "netflix")!
    const other = r.groups.find((g) => !g.listed)!
    expect(groupFolderName(nf)).toBe("Netflix")
    expect(groupFolderName(other)).toBe("_Other/reddit.com")
  })

  it("account filenames fall back to account-N when no label", () => {
    const r = sortCookieBlocks(extractCookieSets(tab(".netflix.com", "NetflixId", NF), "any"), "listed")
    const acc = r.groups[0].accounts[0]
    expect(accountTxtName(acc, 0)).toBe("account-1.txt")
  })
})
