// Pure, dependency-free color helpers shared by BOTH server (brand-color.ts, which
// also talks to Redis) and client (the admin color card + live preview). Keeping
// them here means the client bundle never pulls in the Redis client.

// The built-in Terminal-teal. When the stored value equals this we treat the brand
// as "default" and skip any style override.
export const DEFAULT_BRAND_COLOR = "#14b8a6"

// A curated set of on-brand presets offered as quick-pick swatches.
export const BRAND_PRESETS: { name: string; hex: string }[] = [
  { name: "Teal", hex: "#14b8a6" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Rose", hex: "#f43f5e" },
]

const HEX_RE = /^#?[0-9a-fA-F]{6}$/
const HEX3_RE = /^#?[0-9a-fA-F]{3}$/

// Normalizes user input to a lowercase #rrggbb string, or null if invalid.
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null
  const v = input.trim()
  if (HEX_RE.test(v)) return `#${v.replace("#", "").toLowerCase()}`
  if (HEX3_RE.test(v)) {
    const s = v.replace("#", "").toLowerCase()
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`
  }
  return null
}

// Relative luminance (0–1) from a #rrggbb hex, using the sRGB coefficients.
function luminance(hex: string): number {
  const n = hex.replace("#", "")
  const r = parseInt(n.slice(0, 2), 16) / 255
  const g = parseInt(n.slice(2, 4), 16) / 255
  const b = parseInt(n.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Picks a readable foreground (near-black or white) for text/icons sitting on the
// brand color, so contrast holds for any hue the admin chooses.
export function readableForeground(hex: string): string {
  return luminance(hex) > 0.5 ? "oklch(0.15 0 0)" : "oklch(0.99 0 0)"
}

// A translucent version of the brand color for the ambient glow effects.
export function glowColor(hex: string): string {
  return `color-mix(in srgb, ${hex} 32%, transparent)`
}

// The exact set of CSS custom properties an admin-chosen color overrides. Shared
// by the server-injected <style> and the client live-preview so they stay in sync.
export function brandCssVars(hex: string): Record<string, string> {
  const fg = readableForeground(hex)
  return {
    "--primary": hex,
    "--accent": hex,
    "--ring": hex,
    "--success": hex,
    "--warning": hex,
    "--info": hex,
    "--tc-accent": hex,
    "--tc-glow": glowColor(hex),
    "--sidebar-primary": hex,
    "--sidebar-ring": hex,
    "--primary-foreground": fg,
    "--accent-foreground": fg,
    "--success-foreground": fg,
    "--sidebar-primary-foreground": fg,
  }
}
