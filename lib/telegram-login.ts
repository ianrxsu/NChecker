import { createHash, randomBytes } from "crypto"
import { redis, redisEnabled } from "@/lib/redis"

const TOKEN_TTL_SECONDS = 120
const CANONICAL_SITE_ORIGIN = "https://cookiesmo.i4n.tech"

function key(token: string) {
  return `telegram:website-login:${token}`
}

export async function createTelegramWebsiteLoginToken(telegramUserId: string): Promise<string | null> {
  if (!redisEnabled) return null
  const token = randomBytes(32).toString("base64url")
  await redis.set(key(token), telegramUserId, { ex: TOKEN_TTL_SECONDS })
  return token
}

export async function consumeTelegramWebsiteLoginToken(token: string): Promise<string | null> {
  if (!redisEnabled || !/^[A-Za-z0-9_-]{30,}$/.test(token)) return null
  const userId = await redis.getdel<string>(key(token))
  return userId ? String(userId) : null
}

export function telegramLoginUrl(token: string): string {
  return `${CANONICAL_SITE_ORIGIN}/api/telegram-login?token=${encodeURIComponent(token)}`
}

export function telegramAccountSubject(userId: string): string {
  return `telegram:${createHash("sha256").update(userId).digest("hex")}`
}
