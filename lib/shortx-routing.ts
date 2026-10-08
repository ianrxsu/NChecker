import { redis, redisEnabled } from "@/lib/redis"
import { getCachedConfig, bustConfigCache } from "@/lib/config-cache"

const KEY = "settings:shortxlinks-routing"
const CACHE_KEY = "shortxlinks-routing"
const CACHE_TTL_MS = 30_000

export type ShortXRouting = "website_second" | "website_first"

export async function getShortXRouting(): Promise<ShortXRouting> {
  if (!redisEnabled) return "website_first"
  return getCachedConfig(CACHE_KEY, CACHE_TTL_MS, async () => {
    try {
      const value = await redis.get<string>(KEY)
      return value === "website_second" ? "website_second" : "website_first"
    } catch {
      return "website_first"
    }
  })
}

export async function setShortXRouting(value: ShortXRouting): Promise<ShortXRouting> {
  if (!redisEnabled) throw new Error("Redis is required to save ShortXLinks routing.")
  await redis.set(KEY, value)
  bustConfigCache(CACHE_KEY)
  return value
}

export async function getWebsiteShortXApiToken(): Promise<string | undefined> {
  const routing = await getShortXRouting()
  return routing === "website_second" ? process.env.SHORTXLINKS2_API_TOKEN : process.env.SHORTXLINKS_API_TOKEN
}

export function getShortXRoutingStatus() {
  return {
    firstConfigured: Boolean(process.env.SHORTXLINKS_API_TOKEN),
    secondConfigured: Boolean(process.env.SHORTXLINKS2_API_TOKEN),
  }
}

export function shortXRoutingLabel(value: ShortXRouting): string {
  return value === "website_second" ? "Website: 2nd API; Telegram + extension: 1st API" : "Website: 1st API; Telegram + extension: 1st API"
}
