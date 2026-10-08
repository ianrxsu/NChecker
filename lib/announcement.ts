import { redis, redisEnabled } from "@/lib/redis"

const KEY = "site:announcement"

export type Announcement = {
  message: string
  expiresAt: number
  hidden: boolean
}

export async function getAnnouncement(): Promise<Announcement | null> {
  if (!redisEnabled) return null
  try {
    const value = await redis.get<Announcement>(KEY)
    if (!value || typeof value.message !== "string" || value.hidden || value.expiresAt <= Date.now()) return null
    return { message: value.message, expiresAt: value.expiresAt, hidden: false }
  } catch {
    return null
  }
}

export async function saveAnnouncement(message: string, durationDays: number): Promise<void> {
  if (!redisEnabled) throw new Error("Redis is unavailable")
  const trimmed = message.trim()
  if (!trimmed || trimmed.length > 4000) throw new Error("Message must be between 1 and 4000 characters")
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error("Duration must be between 1 and 3650 days")
  await redis.set(KEY, { message: trimmed, expiresAt: Date.now() + durationDays * 86400000, hidden: false })
}

export async function hideAnnouncement(): Promise<void> {
  if (redisEnabled) await redis.set(KEY, { message: "", expiresAt: 0, hidden: true })
}

export async function deleteAnnouncement(): Promise<void> {
  if (redisEnabled) await redis.del(KEY)
}
