import type { CheckResult } from "@/lib/normalize-upstream"

// ---------------------------------------------------------------------------
// Account-detail translation / normalization.
//
// Netflix returns account fields (member-since, next-billing date, payment
// method) in the ACCOUNT'S OWN LOCALE. Our pool spans dozens of languages, so
// the same field can arrive as "September 2025", "septiembre de 2025",
// "tháng 9 năm 2025", "2025年9月", "กันยายน 2025", etc. This module rewrites
// those into consistent English so the account-generator always shows uniform,
// readable details regardless of the account's country.
//
// It is fully offline (no network/AI dependency) and idempotent: feeding an
// already-English value back through returns the same value.
// ---------------------------------------------------------------------------

const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// Localized month token (lowercased) -> 1-based month number. Covers every
// language observed in the pool plus close neighbors. Many languages use
// genitive/inflected forms (Slavic, Greek, Ukrainian) so multiple spellings map
// to the same month. Numeric-month locales (Vietnamese "tháng N", CJK "N月"/
// "N월") are handled separately below and don't need entries here.
const MONTH_ENTRIES: [string, number][] = [
  // English
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  // Spanish
  ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4], ["mayo", 5], ["junio", 6],
  ["julio", 7], ["agosto", 8], ["septiembre", 9], ["setiembre", 9], ["octubre", 10], ["noviembre", 11], ["diciembre", 12],
  // Portuguese
  ["janeiro", 1], ["fevereiro", 2], ["março", 3], ["marco", 3], ["abril", 4], ["maio", 5], ["junho", 6],
  ["julho", 7], ["agosto", 8], ["setembro", 9], ["outubro", 10], ["novembro", 11], ["dezembro", 12],
  // French
  ["janvier", 1], ["février", 2], ["fevrier", 2], ["mars", 3], ["avril", 4], ["mai", 5], ["juin", 6],
  ["juillet", 7], ["août", 8], ["aout", 8], ["septembre", 9], ["octobre", 10], ["novembre", 11], ["décembre", 12], ["decembre", 12],
  // German
  ["januar", 1], ["februar", 2], ["märz", 3], ["marz", 3], ["april", 4], ["mai", 5], ["juni", 6],
  ["juli", 7], ["august", 8], ["september", 9], ["oktober", 10], ["november", 11], ["dezember", 12],
  // Italian
  ["gennaio", 1], ["febbraio", 2], ["marzo", 3], ["aprile", 4], ["maggio", 5], ["giugno", 6],
  ["luglio", 7], ["agosto", 8], ["settembre", 9], ["ottobre", 10], ["novembre", 11], ["dicembre", 12],
  // Turkish
  ["ocak", 1], ["şubat", 2], ["subat", 2], ["mart", 3], ["nisan", 4], ["mayıs", 5], ["mayis", 5], ["haziran", 6],
  ["temmuz", 7], ["ağustos", 8], ["agustos", 8], ["eylül", 9], ["eylul", 9], ["ekim", 10], ["kasım", 11], ["kasim", 11], ["aralık", 12], ["aralik", 12],
  // Indonesian
  ["januari", 1], ["februari", 2], ["maret", 3], ["mei", 5], ["juni", 6], ["juli", 7], ["agustus", 8], ["desember", 12],
  // Malay
  ["mac", 3], ["jun", 6], ["julai", 7], ["ogos", 8], ["disember", 12],
  // Polish (nominative + genitive)
  ["styczeń", 1], ["stycznia", 1], ["styczen", 1], ["luty", 2], ["lutego", 2], ["marzec", 3], ["marca", 3],
  ["kwiecień", 4], ["kwietnia", 4], ["kwiecien", 4], ["maj", 5], ["maja", 5], ["czerwiec", 6], ["czerwca", 6],
  ["lipiec", 7], ["lipca", 7], ["sierpień", 8], ["sierpnia", 8], ["sierpien", 8], ["wrzesień", 9], ["września", 9], ["wrzesnia", 9],
  ["październik", 10], ["października", 10], ["pazdziernika", 10], ["listopad", 11], ["listopada", 11], ["grudzień", 12], ["grudnia", 12],
  // Czech (genitive)
  ["leden", 1], ["ledna", 1], ["únor", 2], ["unora", 2], ["února", 2], ["březen", 3], ["března", 3], ["brezna", 3],
  ["duben", 4], ["dubna", 4], ["květen", 5], ["května", 5], ["kvetna", 5], ["červen", 6], ["června", 6], ["cervna", 6],
  ["červenec", 7], ["července", 7], ["cervence", 7], ["srpen", 8], ["srpna", 8], ["září", 9], ["zari", 9],
  ["říjen", 10], ["října", 10], ["rijna", 10], ["listopadu", 11], ["prosinec", 12], ["prosince", 12],
  // Croatian (genitive)
  ["siječanj", 1], ["siječnja", 1], ["sijecnja", 1], ["veljača", 2], ["veljače", 2], ["veljace", 2],
  ["ožujak", 3], ["ožujka", 3], ["ozujka", 3], ["travanj", 4], ["travnja", 4], ["svibanj", 5], ["svibnja", 5],
  ["lipanj", 6], ["lipnja", 6], ["srpanj", 7], ["srpnja", 7], ["kolovoz", 8], ["kolovoza", 8],
  ["rujan", 9], ["rujna", 9], ["studeni", 11], ["studenoga", 11], ["prosinac", 12],
  // Hungarian
  ["január", 1], ["februári", 2], ["március", 3], ["marcius", 3], ["április", 4], ["aprilis", 4], ["május", 5], ["majus", 5],
  ["június", 6], ["junius", 6], ["július", 7], ["julius", 7], ["augusztus", 8], ["szeptember", 9], ["október", 10],
  // Ukrainian (genitive)
  ["січня", 1], ["лютого", 2], ["березня", 3], ["квітня", 4], ["травня", 5], ["червня", 6],
  ["липня", 7], ["серпня", 8], ["вересня", 9], ["жовтня", 10], ["листопада", 11], ["грудня", 12],
  // Greek (genitive)
  ["ιανουαρίου", 1], ["ιανουαριου", 1], ["φεβρουαρίου", 2], ["φεβρουαριου", 2], ["μαρτίου", 3], ["μαρτιου", 3],
  ["απριλίου", 4], ["απριλιου", 4], ["μαΐου", 5], ["μαιου", 5], ["ιουνίου", 6], ["ιουνιου", 6],
  ["ιουλίου", 7], ["ιουλιου", 7], ["αυγούστου", 8], ["αυγουστου", 8], ["σεπτεμβρίου", 9], ["σεπτεμβριου", 9],
  ["οκτωβρίου", 10], ["οκτωβριου", 10], ["νοεμβρίου", 11], ["νοεμβριου", 11], ["δεκεμβρίου", 12], ["δεκεμβριου", 12],
  // Hebrew (with and without the "ב"/"ל" prefix meaning "in")
  ["ינואר", 1], ["בינואר", 1], ["פברואר", 2], ["בפברואר", 2], ["מרץ", 3], ["במרץ", 3], ["אפריל", 4], ["באפריל", 4],
  ["מאי", 5], ["במאי", 5], ["יוני", 6], ["ביוני", 6], ["יולי", 7], ["ביולי", 7], ["אוגוסט", 8], ["באוגוסט", 8],
  ["ספטמבר", 9], ["בספטמבר", 9], ["אוקטובר", 10], ["באוקטובר", 10], ["נובמבר", 11], ["בנובמבר", 11], ["דצמבר", 12], ["בדצמבר", 12],
  // Arabic — Modern Standard
  ["يناير", 1], ["فبراير", 2], ["مارس", 3], ["أبريل", 4], ["ابريل", 4], ["مايو", 5], ["يونيو", 6],
  ["يوليو", 7], ["أغسطس", 8], ["اغسطس", 8], ["سبتمبر", 9], ["أكتوبر", 10], ["اكتوبر", 10], ["نوفمبر", 11], ["ديسمبر", 12],
  // Arabic — Moroccan (Maghrebi)
  ["ماي", 5], ["يوليوز", 7], ["غشت", 8], ["شتنبر", 9], ["نونبر", 11], ["دجنبر", 12],
  // Arabic — Tunisian / Algerian
  ["جانفي", 1], ["فيفري", 2], ["أفريل", 4], ["افريل", 4], ["جوان", 6], ["جويلية", 7], ["أوت", 8], ["اوت", 8],
  // Hindi
  ["जनवरी", 1], ["फ़रवरी", 2], ["फरवरी", 2], ["मार्च", 3], ["अप्रैल", 4], ["मई", 5], ["जून", 6],
  ["जुलाई", 7], ["अगस्त", 8], ["सितंबर", 9], ["सितम्बर", 9], ["अक्तूबर", 10], ["अक्टूबर", 10], ["नवंबर", 11], ["नवम्बर", 11], ["दिसंबर", 12], ["दिसम्बर", 12],
  // Thai
  ["มกราคม", 1], ["กุมภาพันธ์", 2], ["มีนาคม", 3], ["เมษายน", 4], ["พฤษภาคม", 5], ["มิถุนายน", 6],
  ["กรกฎาคม", 7], ["สิงหาคม", 8], ["กันยายน", 9], ["ตุลาคม", 10], ["พฤศจิกายน", 11], ["ธันวาคม", 12],
]

// Longest tokens first so e.g. "maio" wins before "mai", "juni" before "jun".
const MONTH_TOKENS = MONTH_ENTRIES.map(([tok, m]) => [tok.toLowerCase(), m] as const).sort(
  (a, b) => b[0].length - a[0].length,
)

// Maps assorted non-ASCII digit scripts to ASCII so year/day extraction works.
const DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", // Arabic-Indic
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9", // Extended Arabic-Indic
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9", // Devanagari
  "๐": "0", "๑": "1", "๒": "2", "๓": "3", "๔": "4", "๕": "5", "๖": "6", "๗": "7", "๘": "8", "๙": "9", // Thai
}

function asciiDigits(s: string): string {
  return s.replace(/./gu, (ch) => DIGIT_MAP[ch] ?? ch)
}

// Normalizes a localized date string into "Month D, YYYY" (when a day is
// present) or "Month YYYY". Returns the original trimmed string when it can't
// confidently parse a month, so we never show worse output than the source.
export function normalizeDateToEnglish(input: string | null | undefined): string | null {
  if (input == null) return input ?? null
  const original = String(input).trim()
  if (!original) return original

  const s = asciiDigits(original)

  // Pure numeric formats like 22/07/26 or 7/1/26 (no month word).
  const slash = s.match(/^\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})\s*$/)
  if (slash) {
    let a = parseInt(slash[1], 10)
    let b = parseInt(slash[2], 10)
    let y = parseInt(slash[3], 10)
    if (y < 100) y += 2000
    // If the first field can't be a month it's day-first (most of the world);
    // otherwise assume month-first (US-style).
    const monthFirst = a <= 12 && b <= 12 ? true : a > 12 ? false : true
    const day = monthFirst ? b : a
    const month = monthFirst ? a : b
    if (month >= 1 && month <= 12) return `${ENGLISH_MONTHS[month - 1]} ${day}, ${y}`
    return original
  }

  // Year: first 4-digit run. Thai Buddhist-era years (>2400) convert to CE.
  const yearMatch = s.match(/\d{4}/)
  let year = yearMatch ? parseInt(yearMatch[0], 10) : undefined
  if (year != null && (/\bBE\b/i.test(s) || year > 2400)) year -= 543

  // Month — numeric-month locales first.
  let month: number | undefined
  let consumed = "" // substring to strip before hunting for the day number

  const vi = s.match(/tháng\s*(\d{1,2})/i) // Vietnamese: "tháng 7"
  const cjk = s.match(/(\d{1,2})\s*[月월]/) // Japanese/Chinese/Korean: "7月" / "7월"
  if (vi) {
    month = parseInt(vi[1], 10)
    consumed = vi[0]
  } else if (cjk) {
    month = parseInt(cjk[1], 10)
    consumed = cjk[0]
  } else {
    const lower = s.toLowerCase()
    for (const [tok, m] of MONTH_TOKENS) {
      if (lower.includes(tok)) {
        month = m
        break
      }
    }
  }

  if (month == null || month < 1 || month > 12 || year == null) return original

  // Day: first 1-2 digit number that isn't the year or the consumed month digits.
  let rest = s.replace(yearMatch![0], " ")
  if (consumed) rest = rest.replace(consumed, " ")
  const dayMatch = rest.match(/\b(\d{1,2})\b/)
  const day = dayMatch ? parseInt(dayMatch[1], 10) : undefined

  if (day != null && day >= 1 && day <= 31) return `${ENGLISH_MONTHS[month - 1]} ${day}, ${year}`
  return `${ENGLISH_MONTHS[month - 1]} ${year}`
}

// Light normalization for localized generic payment terms. Brand names
// (Visa, Mastercard, American Express, PayPal…) are already universal and pass
// through unchanged; only clearly-localized "credit card" style phrases and the
// terse "Cc" code are rewritten.
const PAYMENT_MAP: [RegExp, string][] = [
  [/^cc$/i, "Credit card"],
  [/tarjeta de cr[eé]dito|tarjeta/i, "Credit card"],
  [/cart[ãa]o de cr[eé]dito/i, "Credit card"],
  [/carte (de cr[eé]dit|bancaire)/i, "Credit card"],
  [/kreditkarte/i, "Credit card"],
  [/carta di credito/i, "Credit card"],
  [/บัตรเครดิต/i, "Credit card"],
  [/credit ?card/i, "Credit card"],
]

export function normalizePaymentMethod(input: string | null | undefined): string | null {
  if (input == null) return input ?? null
  const v = String(input).trim()
  if (!v) return v
  for (const [re, label] of PAYMENT_MAP) if (re.test(v)) return label
  return v
}

// Returns a copy of the result with its localized detail fields rewritten to
// English. Used by the account generator so every granted account reads
// consistently regardless of its country of origin.
export function translateAccountResult(result: CheckResult): CheckResult {
  return {
    ...result,
    memberSince: normalizeDateToEnglish(result.memberSince) ?? undefined,
    nextBillingCycle: normalizeDateToEnglish(result.nextBillingCycle) ?? undefined,
    paymentMethod: normalizePaymentMethod(result.paymentMethod) ?? undefined,
  }
}
