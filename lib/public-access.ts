import { cookies } from "next/headers"
import { redis, redisEnabled } from "@/lib/redis"

const KEY = "config:public-access-password"
const COOKIE = "public_access"
const TTL = 60 * 60 * 24 * 2
const ENABLED_KEY = "config:public-access-enabled"

function secret() { return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "" }

async function sign(value: string) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function valid(value?: string | null) {
  if (!value) return false
  const [expires, mac] = value.split(".")
  if (!expires || !mac || Number(expires) < Math.floor(Date.now() / 1000)) return false
  const expected = await sign(expires)
  return mac.length === expected.length && mac === expected
}
export async function getPublicPassword() { return redisEnabled ? ((await redis.get<string>(KEY)) || process.env.PUBLIC_ACCESS_PASSWORD || "") : (process.env.PUBLIC_ACCESS_PASSWORD || "") }
export async function setPublicPassword(password: string) { if (!redisEnabled) throw new Error("Redis is required to persist this setting."); await redis.set(KEY, password) }
export async function isPublicAccessEnabled() {
  if (!redisEnabled) return true
  const value = await redis.get<string>(ENABLED_KEY)
  return value !== "disabled" && value !== "false"
}
export async function setPublicAccessEnabled(enabled: boolean) {
  if (!redisEnabled) throw new Error("Redis is required to persist this setting.")
  await redis.set(ENABLED_KEY, enabled ? "enabled" : "disabled")
  if (!enabled) await clearPublicAccess()
}
export async function hasPublicAccess() { const store = await cookies(); return valid(store.get(COOKIE)?.value) }
export async function grantPublicAccess() { const store = await cookies(); const expires = Math.floor(Date.now() / 1000) + TTL; store.set(COOKIE, `${expires}.${await sign(String(expires))}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TTL }) }
export async function clearPublicAccess() { const store = await cookies(); store.delete(COOKIE) }
export const PUBLIC_ACCESS_COOKIE = COOKIE
export const PUBLIC_ACCESS_TTL = TTL
export async function validPublicAccessCookie(value?: string | null) { return valid(value) }
