import { describe, it, expect } from "vitest"
import { normalizeDateToEnglish, normalizePaymentMethod } from "./translate-details"

describe("normalizeDateToEnglish", () => {
  it("passes English through unchanged (idempotent)", () => {
    expect(normalizeDateToEnglish("July 11, 2026")).toBe("July 11, 2026")
    expect(normalizeDateToEnglish("September 2025")).toBe("September 2025")
  })

  it("translates Vietnamese", () => {
    expect(normalizeDateToEnglish("3 tháng 7, 2026")).toBe("July 3, 2026")
    expect(normalizeDateToEnglish("tháng 9 năm 2024")).toBe("September 2024")
  })

  it("translates Arabic (MSA, Moroccan, Tunisian) with Arabic-Indic digits", () => {
    expect(normalizeDateToEnglish("1 يوليو 2026")).toBe("July 1, 2026")
    expect(normalizeDateToEnglish("22 يوليوز 2026")).toBe("July 22, 2026") // Moroccan July
    expect(normalizeDateToEnglish("فيفري 2026")).toBe("February 2026") // Tunisian Feb
    expect(normalizeDateToEnglish("مارس ٢٠٢٦")).toBe("March 2026")
  })

  it("translates Thai including Buddhist-era years", () => {
    expect(normalizeDateToEnglish("12 กรกฎาคม 2026")).toBe("July 12, 2026")
    expect(normalizeDateToEnglish("10 tháng 7, 2569 BE")).toBe("July 10, 2026")
  })

  it("translates Greek, Hebrew, Hindi, Ukrainian, Czech, Croatian, Hungarian", () => {
    expect(normalizeDateToEnglish("12 Ιουλίου 2026")).toBe("July 12, 2026")
    expect(normalizeDateToEnglish("12 ביולי 2026")).toBe("July 12, 2026")
    expect(normalizeDateToEnglish("17 जुलाई 2026")).toBe("July 17, 2026")
    expect(normalizeDateToEnglish("19 липня 2026 р.")).toBe("July 19, 2026")
    expect(normalizeDateToEnglish("19. července 2026")).toBe("July 19, 2026")
    expect(normalizeDateToEnglish("20. srpnja 2026.")).toBe("July 20, 2026")
    expect(normalizeDateToEnglish("2026. július 1.")).toBe("July 1, 2026")
  })

  it("translates CJK (Japanese/Korean) member-since", () => {
    expect(normalizeDateToEnglish("2024年11月")).toBe("November 2024")
    expect(normalizeDateToEnglish("2025년 12월")).toBe("December 2025")
  })

  it("translates European month-year member-since forms", () => {
    expect(normalizeDateToEnglish("dezembro de 2025")).toBe("December 2025")
    expect(normalizeDateToEnglish("septiembre de 2025")).toBe("September 2025")
    expect(normalizeDateToEnglish("août 2025")).toBe("August 2025")
    expect(normalizeDateToEnglish("Aralık 2025")).toBe("December 2025")
    expect(normalizeDateToEnglish("Desember 2025")).toBe("December 2025")
    expect(normalizeDateToEnglish("lipiec 2025")).toBe("July 2025")
  })

  it("handles numeric slash formats", () => {
    expect(normalizeDateToEnglish("22/07/26")).toBe("July 22, 2026")
    expect(normalizeDateToEnglish("7/1/26")).toBe("July 1, 2026")
  })
})

describe("normalizePaymentMethod", () => {
  it("keeps brand names", () => {
    expect(normalizePaymentMethod("Visa")).toBe("Visa")
    expect(normalizePaymentMethod("Mastercard")).toBe("Mastercard")
    expect(normalizePaymentMethod("American Express")).toBe("American Express")
  })
  it("normalizes Cc and localized credit-card phrases", () => {
    expect(normalizePaymentMethod("Cc")).toBe("Credit card")
    expect(normalizePaymentMethod("Cartão de crédito")).toBe("Credit card")
  })
})
