import { redis, redisEnabled } from "./redis"
import { getCachedConfig, bustConfigCache } from "./config-cache"
import { DEFAULT_BRAND_COLOR, normalizeHex } from "./brand-color-utils"

// The site's dynamic MAIN color (teal by default). Stored in Redis so an admin can
// recolor the whole app — every `--primary`/`--accent`/`--ring` token, glows, the
// logo tile and the favicon — instantly across all instances, no redeploy.
//
// We store a single hex string. The layout injects it (plus a derived readable
// foreground + glow) as a `<style>` override, and the favicon route inlines it.
// Pure color math + presets live in ./brand-color-utils (client-safe).

// Re-export the pure helpers so server callers can import everything from here.
export { DEFAULT_BRAND_COLOR, normalizeHex, readableForeground, glowColor, brandCssVars } from "./brand-color-utils"

const KEY = "site:brand-color"
const CACHE_KEY = "brand-color"
const CACHE_TTL_MS = 30_000

export type BrandColor = {
  // Normalized #rrggbb hex.
  color: string
  // True when an admin has explicitly chosen a non-default color.
  isCustom: boolean
}

// Reads the current brand color. Fails open to the default teal whenever Redis is
// unavailable, so a flaky store never leaves the UI uncolored.
export async function getBrandColor(): Promise<BrandColor> {
  if (!redisEnabled) return { color: DEFAULT_BRAND_COLOR, isCustom: false }
  return getCachedConfig(CACHE_KEY, CACHE_TTL_MS, async () => {
    try {
      const raw = await redis.get<string>(KEY)
      const norm = normalizeHex(raw)
      if (!norm) return { color: DEFAULT_BRAND_COLOR, isCustom: false }
      return { color: norm, isCustom: norm !== DEFAULT_BRAND_COLOR }
    } catch {
      return { color: DEFAULT_BRAND_COLOR, isCustom: false }
    }
  })
}

// Persists a new brand color (or resets to default when null/default is passed).
export async function setBrandColor(input: string | null): Promise<BrandColor> {
  const norm = input === null ? DEFAULT_BRAND_COLOR : normalizeHex(input)
  if (!norm) throw new Error("Invalid color — expected a hex value like #14b8a6.")
  const next: BrandColor = { color: norm, isCustom: norm !== DEFAULT_BRAND_COLOR }
  if (redisEnabled) {
    try {
      await redis.set(KEY, norm)
      bustConfigCache(CACHE_KEY)
    } catch {
      throw new Error("Could not save the color — the settings store is unavailable.")
    }
  }
  return next
}
