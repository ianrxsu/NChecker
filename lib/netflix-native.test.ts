import { describe, it, expect } from "vitest"
import { __i18n, __classify, __decodeEscapes, collectProfileNames } from "./netflix-native"

const { englishifyDate, englishifyPlan, derivePlanFromSignals, englishifyPayment } = __i18n
const { isBlockedInterstitial, looksLikeNetflixLoggedOut } = __classify

describe("decodeEscapes — UTF-8 byte runs decode without mojibake", () => {
  it("decodes ASCII \\xNN escapes", () => {
    expect(__decodeEscapes("user\\x40gmail.com")).toBe("user@gmail.com")
  })

  it("decodes multi-byte accented names (José, Müller)", () => {
    expect(__decodeEscapes("Jos\\xc3\\xa9")).toBe("José")
    expect(__decodeEscapes("M\\xc3\\xbcller")).toBe("Müller")
  })

  it("decodes CJK profile names", () => {
    // 田中 -> UTF-8 e7 94 b0 e4 b8 ad
    expect(__decodeEscapes("\\xe7\\x94\\xb0\\xe4\\xb8\\xad")).toBe("田中")
  })

  it("decodes emoji profile names (4-byte sequences)", () => {
    // 😀 U+1F600 -> UTF-8 f0 9f 98 80
    expect(__decodeEscapes("\\xf0\\x9f\\x98\\x80")).toBe("😀")
  })

  it("decodes \\uNNNN escapes including surrogate pairs", () => {
    expect(__decodeEscapes("\\u00a0").charCodeAt(0)).toBe(0xa0)
    expect(__decodeEscapes("\\ud83d\\ude00")).toBe("😀")
  })

  it("leaves plain text untouched", () => {
    expect(__decodeEscapes("Living Room")).toBe("Living Room")
  })
})

describe("collectProfileNames — returns the complete deduplicated list", () => {
  it("supports current, legacy, and markup profile formats", () => {
    expect(collectProfileNames(`{"profileName":"Main"},{"profile_name":"Kids"},data-profile-name="Travel",aria-label="Profile: Main"`)).toEqual(["Main", "Kids", "Travel"])
  })

  it("returns undefined when no profiles are present", () => {
    expect(collectProfileNames("account page without profile data")).toBeUndefined()
  })
})

describe("proxy false-dead guard — block pages are NOT trusted as dead", () => {
  it("flags common proxy/edge interstitials as blocked", () => {
    expect(isBlockedInterstitial("<h1>Pardon the interruption</h1>")).toBe(true)
    expect(isBlockedInterstitial("Access Denied")).toBe(true)
    expect(isBlockedInterstitial("Request unsuccessful. Incapsula incident ID...")).toBe(true)
    expect(isBlockedInterstitial("<title>Just a moment...</title>")).toBe(true)
    expect(isBlockedInterstitial("Please complete the CAPTCHA")).toBe(true)
    expect(isBlockedInterstitial("Netflix is not available in your country")).toBe(true)
    expect(isBlockedInterstitial("")).toBe(true) // empty body is never a trustworthy dead
  })

  it("does NOT flag a normal Netflix page as blocked", () => {
    expect(isBlockedInterstitial('<div id="appMountPoint">Netflix sign in</div>')).toBe(false)
  })

  it("recognizes an authentic Netflix logged-out page (a real dead)", () => {
    const loginHtml = '<html><body><div id="appMountPoint"></div><form action="/login"><input type="password"/>Sign In to Netflix</form><a href="https://netflix.com/signup">login</a></body></html>'
    expect(looksLikeNetflixLoggedOut(loginHtml)).toBe(true)
  })

  it("does NOT treat a proxy block page as a Netflix logged-out page", () => {
    expect(looksLikeNetflixLoggedOut("Access Denied — you don't have permission")).toBe(false)
    expect(looksLikeNetflixLoggedOut("")).toBe(false)
  })
})

describe("englishifyDate — localized billing dates render in English", () => {
  const cases: [string, string][] = [
    ["6 de julio de 2026", "July 6, 2026"], // Spanish
    ["6 de julho de 2026", "July 6, 2026"], // Portuguese
    ["6 juillet 2026", "July 6, 2026"], // French
    ["6. Juli 2026", "July 6, 2026"], // German
    ["6 luglio 2026", "July 6, 2026"], // Italian
    ["6 juli 2026", "July 6, 2026"], // Dutch / Swedish
    ["6 lipca 2026", "July 6, 2026"], // Polish
    ["6 Temmuz 2026", "July 6, 2026"], // Turkish
    ["6 Juli 2026", "July 6, 2026"], // Indonesian
    ["6 iulie 2026", "July 6, 2026"], // Romanian
    ["2026年7月6日", "July 6, 2026"], // Japanese / Chinese
    ["2026년 7월 6일", "July 6, 2026"], // Korean
    ["2026-07-06", "July 6, 2026"], // ISO
    ["06.07.2026", "July 6, 2026"], // German numeric DMY
    ["06/07/2026", "July 6, 2026"], // numeric DMY
  ]
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(englishifyDate(input)).toBe(expected)
    })
  }

  it("returns the original string when nothing parses", () => {
    expect(englishifyDate("sometime soon")).toBe("sometime soon")
  })
})

describe("englishifyPlan — localized plan names map to canonical English tiers", () => {
  const cases: [string, string | undefined][] = [
    ["Estándar", "Standard"],
    ["Padrão", "Standard"],
    ["Standart", "Standard"], // Turkish
    ["Premium", "Premium"],
    ["Premium (Miembro Extra)", "Premium"],
    ["Básico", "Basic"],
    ["Temel", "Basic"], // Turkish
    ["Móvil", "Mobile"],
    ["Ponsel", "Mobile"], // Indonesian
    ["プレミアム", undefined], // unrecognized script -> undefined (caller falls back)
  ]
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(englishifyPlan(input)).toBe(expected)
    })
  }
})

describe("derivePlanFromSignals — locale-independent plan fallback", () => {
  it("UHD/4K -> Premium", () => expect(derivePlanFromSignals("UHD", 4)).toBe("Premium"))
  it("4 streams -> Premium", () => expect(derivePlanFromSignals("HD", 4)).toBe("Premium"))
  it("FHD -> Standard", () => expect(derivePlanFromSignals("FHD", 2)).toBe("Standard"))
  it("2 streams -> Standard", () => expect(derivePlanFromSignals("HD", 2)).toBe("Standard"))
  it("SD + 1 stream -> Basic", () => expect(derivePlanFromSignals("SD", 1)).toBe("Basic"))
})

describe("englishifyPayment — enums/brands resolve to English labels", () => {
  it("prefers a known brand from the logo", () => {
    expect(englishifyPayment("MOBILE_WALLET", "GCASH")).toBe("GCash")
    expect(englishifyPayment("CREDIT_CARD", "VISA")).toBe("Visa")
  })
  it("maps method enums to friendly labels", () => {
    expect(englishifyPayment("MOBILE_WALLET")).toBe("Mobile Wallet")
    expect(englishifyPayment("DCB")).toBe("Carrier Billing")
    expect(englishifyPayment("PAYPAL")).toBe("PayPal")
  })
  it("title-cases unknown enums so they read as English", () => {
    expect(englishifyPayment("FOO_BAR")).toBe("Foo Bar")
  })
})
