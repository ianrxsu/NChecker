import { redis, redisEnabled } from "@/lib/redis"
import { bustConfigCache, getCachedConfig } from "@/lib/config-cache"

const KEY = "admin:moderator-access"
const CACHE_KEY = "moderator-access"

type ModeratorAccess = { enabled: boolean; password: string | null; updatedAt: number }

const fallback = (): ModeratorAccess => ({ enabled: true, password: null, updatedAt: Date.now() })

export async function getModeratorAccess(): Promise<ModeratorAccess> {
  return getCachedConfig(CACHE_KEY, 30_000, async () => {
    if (!redisEnabled) return fallback()
    return (await redis.get<ModeratorAccess>(KEY)) ?? fallback()
  })
}

export async function isModeratorEnabled(): Promise<boolean> {
  return (await getModeratorAccess()).enabled
}

export async function getModeratorPassword(): Promise<string | null> {
  const access = await getModeratorAccess()
  return access.password || process.env.MOD_PASSWORD || null
}

export async function updateModeratorAccess(input: { enabled?: boolean; password?: string | null }): Promise<ModeratorAccess> {
  const current = await getModeratorAccess()
  const next: ModeratorAccess = {
    enabled: input.enabled ?? current.enabled,
    password: input.password === undefined ? current.password : input.password,
    updatedAt: Date.now(),
  }
  if (redisEnabled) await redis.set(KEY, next)
  bustConfigCache(CACHE_KEY)
  return next
}
