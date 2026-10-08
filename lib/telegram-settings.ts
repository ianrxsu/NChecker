import { redis, redisEnabled } from "@/lib/redis"

const KEY = "settings:telegram-webhook-secret"

export async function getTelegramWebhookSecret(): Promise<string | null> {
  if (!redisEnabled) return null
  try {
    const value = await redis.get<string>(KEY)
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export async function setTelegramWebhookSecret(value: string): Promise<void> {
  if (!redisEnabled) throw new Error("Redis is required to save the Telegram webhook secret.")
  const secret = value.trim()
  if (secret.length < 32 || secret.length > 256) throw new Error("Secret must be between 32 and 256 characters.")
  await redis.set(KEY, secret)
}

export async function clearTelegramWebhookSecret(): Promise<void> {
  if (!redisEnabled) return
  await redis.del(KEY)
}
