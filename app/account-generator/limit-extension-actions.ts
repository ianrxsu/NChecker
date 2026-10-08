"use server"

import { randomUUID } from "node:crypto"
import { redirect } from "next/navigation"
import { getOrCreateDeviceId } from "@/lib/device-id"
import { getClaimLimits } from "@/lib/claim-limits"
import { redis, redisEnabled } from "@/lib/redis"
import { buildShortXLinksReturnUrl, shortenWithShortXLinks } from "@/lib/shortxlinks"

export async function startNetflixLimitExtension(): Promise<void> {
  const deviceId = await getOrCreateDeviceId()
  if (!redisEnabled || !process.env.TELEGRAM_SHORTXLINKS_API_TOKEN) {
    redirect("/account-generator?unlock=error")
  }
  const token = randomUUID()
  const limits = await getClaimLimits()
  const extensionKey = `claims:netflix:extension:${deviceId}`
  const extensionAlreadyUsed = await redis.get(extensionKey)
  if (extensionAlreadyUsed !== null) {
    redirect("/account-generator?unlock=already-used")
  }
  const activeToken = await redis.get(`web:netflix-extension:active:${deviceId}`)
  if (activeToken) {
    redirect("/account-generator?unlock=already-started")
  }
  await redis.set(`web:netflix-extension:pending:${token}`, { deviceId }, { ex: limits.netflix.windowSeconds })
  const destination = buildShortXLinksReturnUrl("https://netflixchecker.i4n.tech", token)
  const result = await shortenWithShortXLinks(destination, process.env.TELEGRAM_SHORTXLINKS_API_TOKEN)
  if (!result.ok) {
    await redis.del(`web:netflix-extension:pending:${token}`)
    redirect("/account-generator?unlock=error")
  }
  await redis.set(`web:netflix-extension:active:${deviceId}`, token, { ex: 3600 })
  void limits
  redirect(result.url)
}

export async function getNetflixExtensionLimit(): Promise<number> {
  const limits = await getClaimLimits()
  return limits.netflix.limit
}

export async function extensionWindowSeconds(): Promise<number> {
  const limits = await getClaimLimits()
  return limits.netflix.windowSeconds
}

export async function isNetflixExtensionPending(deviceId: string): Promise<boolean> {
  if (!redisEnabled || !deviceId) return false
  return Boolean(await redis.get(`web:netflix-extension:active:${deviceId}`))
}

export async function isNetflixExtensionUsed(deviceId: string): Promise<boolean> {
  if (!redisEnabled || !deviceId) return false
  return (await redis.get(`claims:netflix:extension:${deviceId}`)) !== null
}

export async function extensionSuccessUrl(): Promise<string> {
  return "/account-generator?unlock=success"
}

export async function extensionErrorUrl(): Promise<string> {
  return "/account-generator?unlock=error"
}

type ExtensionPending = { deviceId: string }
export async function consumeNetflixExtensionToken(token: string): Promise<ExtensionPending | null> {
  if (!redisEnabled) return null
  const pending = await redis.get<ExtensionPending>(`web:netflix-extension:pending:${token}`)
  if (!pending?.deviceId) return null
  const consumed = await redis.set(`web:netflix-extension:consumed:${token}`, "1", { nx: true, ex: 3600 })
  if (!consumed) return null
  await redis.del(`web:netflix-extension:pending:${token}`, `web:netflix-extension:active:${pending.deviceId}`)
  return pending
}

export async function redirectAfterExtension(): Promise<void> {
  redirect("/account-generator?unlock=success")
}
