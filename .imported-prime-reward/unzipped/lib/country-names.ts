// Resolves a 2-letter ISO 3166-1 alpha-2 code (e.g. "BR") into a full, localized
// country name (e.g. "Brazil"). Uses the platform Intl.DisplayNames table, with a
// tiny fallback map for the handful of codes that aren't standard ISO regions or
// that some runtimes leave unresolved.

// Codes that Intl.DisplayNames may not resolve, or that we want to label
// explicitly. Kept intentionally small.
const FALLBACK: Record<string, string> = {
  UK: "United Kingdom", // common non-standard alias for GB
  XK: "Kosovo",
}

let displayNames: Intl.DisplayNames | null = null
function getDisplayNames(): Intl.DisplayNames | null {
  if (displayNames) return displayNames
  try {
    displayNames = new Intl.DisplayNames(["en"], { type: "region" })
  } catch {
    displayNames = null
  }
  return displayNames
}

// Returns the full English country name for a code, falling back to the
// upper-cased code itself if it can't be resolved (so the UI never shows blanks).
export function countryName(code: string): string {
  if (!code) return ""
  const upper = code.trim().toUpperCase()
  if (FALLBACK[upper]) return FALLBACK[upper]
  // Intl expects valid alpha-2 (or alpha-3/UN M49) region codes.
  if (/^[A-Z]{2}$/.test(upper)) {
    const dn = getDisplayNames()
    if (dn) {
      try {
        const name = dn.of(upper)
        if (name && name !== upper) return name
      } catch {
        // fall through to returning the code
      }
    }
  }
  return upper
}

// Turns a 2-letter country code into its flag emoji (regional indicators).
// NOTE: many platforms (notably Windows) don't render these and instead show the
// two letters, so callers should treat the flag as decorative-only and never rely
// on it as the country label.
export function flagEmoji(code: string): string {
  if (!/^[a-z]{2}$/i.test(code)) return ""
  const base = 0x1f1e6
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => base + (c.charCodeAt(0) - 65)),
  )
}
