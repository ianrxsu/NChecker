import { describe, it, expect } from "vitest"
import { normalizeUpstream, buildAuthLinks, buildDemoResult } from "./normalize-upstream"

describe("normalizeUpstream", () => {
  it("handles a null / empty payload", () => {
    const r = normalizeUpstream(null)
    expect(r.valid).toBe(false)
    expect(r.message).toMatch(/empty/i)
  })

  it("maps the API's short x_ keys into the canonical shape", () => {
    const r = normalizeUpstream({
      status: "VALID",
      x_mail: "user@example.com",
      x_tier: "PREMIUM",
      x_loc: "US",
      x_bil: "CREDIT_CARD",
      x_ren: "2026-01-15",
      x_mem: "January 2021",
      x_tel: "639400000000",
      x_usr: "Burnok, Kids, J",
    })
    expect(r.valid).toBe(true)
    expect(r.email).toBe("user@example.com")
    expect(r.plan).toBe("PREMIUM")
    expect(r.countryCode).toBe("US")
    expect(r.paymentMethod).toBe("CREDIT_CARD")
    expect(r.nextBillingCycle).toBe("2026-01-15")
    expect(r.memberSince).toBe("January 2021")
    expect(r.phone).toBe("+639400000000")
    expect(r.profiles).toEqual(["Burnok", "Kids", "J"])
  })

  it("is case / space / underscore insensitive on keys", () => {
    const r = normalizeUpstream({ "Email Address": "a@b.com", Plan_Name: "Standard", VALID: true })
    expect(r.email).toBe("a@b.com")
    expect(r.plan).toBe("Standard")
    expect(r.valid).toBe(true)
  })

  it("unwraps a nested data/result/account envelope", () => {
    const r = normalizeUpstream({ result: { valid: true, email: "nested@x.com", plan: "BASIC" } })
    expect(r.valid).toBe(true)
    expect(r.email).toBe("nested@x.com")
    expect(r.plan).toBe("BASIC")
  })

  it("treats negative status text as invalid even with positive-looking words", () => {
    expect(normalizeUpstream({ status: "expired premium" }).valid).toBe(false)
    expect(normalizeUpstream({ status: "invalid" }).valid).toBe(false)
    expect(normalizeUpstream({ status: "dead" }).valid).toBe(false)
  })

  it("infers validity from positive status words", () => {
    expect(normalizeUpstream({ status: "active" }).valid).toBe(true)
    expect(normalizeUpstream({ status: "working" }).valid).toBe(true)
  })

  it("honors explicit boolean truthiness flags", () => {
    expect(normalizeUpstream({ alive: true }).valid).toBe(true)
    expect(normalizeUpstream({ success: "yes" }).valid).toBe(true)
    expect(normalizeUpstream({ valid: "no" }).valid).toBe(false)
  })

  it("formats bare numeric phones and leaves formatted ones alone", () => {
    expect(normalizeUpstream({ phone: "639400000000" }).phone).toBe("+639400000000")
    expect(normalizeUpstream({ phone: "+1 (555) 123" }).phone).toBe("+1 (555) 123")
  })

  it("coerces numeric and string maxStreams / emailVerified", () => {
    const r = normalizeUpstream({ maxStreams: "4", emailVerified: "true" })
    expect(r.maxStreams).toBe(4)
    expect(r.emailVerified).toBe(true)
  })

  it("reads an array of profile objects", () => {
    const r = normalizeUpstream({ profiles: [{ name: "A" }, { profileName: "B" }, "C"] })
    expect(r.profiles).toEqual(["A", "B", "C"])
  })

  it("prefers explicit link fields, then x_l# fields, then a token", () => {
    expect(normalizeUpstream({ x_l1: "https://pc", x_l2: "https://m", x_l3: "https://tv" }).links).toEqual({
      pc: "https://pc",
      mobile: "https://m",
      tv: "https://tv",
    })
    const tokenLinks = normalizeUpstream({ nftoken: "TOK" }).links
    expect(tokenLinks?.pc).toBe("https://netflix.com/?nftoken=TOK")
  })

  it("always preserves the raw payload", () => {
    const input = { weird: "value" }
    expect(normalizeUpstream(input).raw).toBe(input)
  })
})

describe("buildAuthLinks", () => {
  it("uses no-www netflix.com with per-device paths and the RAW token", () => {
    const links = buildAuthLinks("Bgi8u+vc/Ax=")
    expect(links.pc).toBe("https://netflix.com/?nftoken=Bgi8u+vc/Ax=")
    expect(links.mobile).toBe("https://netflix.com/unsupported?nftoken=Bgi8u+vc/Ax=")
    expect(links.tv).toBe("https://netflix.com/tv2?nftoken=Bgi8u+vc/Ax=")
  })
})

describe("buildDemoResult", () => {
  it("is deterministic for a given cookie", () => {
    const a = buildDemoResult("NetflixId=abcdefghijklmnopqrstuvwxyz123")
    const b = buildDemoResult("NetflixId=abcdefghijklmnopqrstuvwxyz123")
    expect(a).toEqual(b)
  })

  it("marks short cookies as invalid", () => {
    const r = buildDemoResult("short")
    expect(r.valid).toBe(false)
    expect(r.message).toMatch(/expired|invalid/i)
  })

  it("produces a complete card for a valid demo cookie", () => {
    // Find a cookie that hashes to a valid demo account.
    let cookie = ""
    for (let i = 0; i < 50; i++) {
      const candidate = `NetflixId=demo-cookie-value-${i}-abcdefghijklmnop`
      if (buildDemoResult(candidate).valid) {
        cookie = candidate
        break
      }
    }
    expect(cookie).not.toBe("")
    const r = buildDemoResult(cookie)
    expect(r.valid).toBe(true)
    expect(r.email).toBeTruthy()
    expect(r.plan).toBeTruthy()
    expect(r.links?.pc).toMatch(/^https:\/\/netflix\.com\/\?nftoken=/)
  })
})
