import { redis, redisEnabled } from "@/lib/redis"

export type DailyCompletionStats = {
  website: number
  telegram: number
  extension: number
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function key(kind: keyof DailyCompletionStats): string {
  return `stats:daily-completions:${dayKey()}:${kind}`
}

export async function incrementDailyCompletion(kind: keyof DailyCompletionStats): Promise<void> {
  if (!redisEnabled) return
  await redis.incr(key(kind))
}

export async function getDailyCompletionStats(): Promise<DailyCompletionStats> {
  if (!redisEnabled) return { website: 0, telegram: 0, extension: 0 }
  const [website, telegram, extension] = await Promise.all([
    redis.get<number>(key("website")),
    redis.get<number>(key("telegram")),
    redis.get<number>(key("extension")),
  ])
  return { website: Number(website || 0), telegram: Number(telegram || 0), extension: Number(extension || 0) }
}
