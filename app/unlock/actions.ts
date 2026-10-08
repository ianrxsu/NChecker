"use server"

import { cookies } from "next/headers"
import { redirect, unstable_rethrow } from "next/navigation"
import { createRewardSession } from "@/lib/reward-store"
import { requestIp } from "@/lib/request-ip"
import { getOrCreateDeviceId } from "@/lib/device-id"
import { isAccessPassMode, getPass } from "@/lib/access-pass"
import { buildGatewayUrl } from "@/lib/gateway-url"
import { redeemAccessCode } from "@/lib/access-codes"
import { consumeAccessCodeRedemption, consumeUnlockStart } from "@/lib/rate-limit"
import type { GeneratorService as Service } from "@/lib/check-via-proxies"
import {
  REWARD_TOKEN_COOKIE,
  REWARD_TOKEN_MAX_AGE,
  parseRewardTokens,
  serializeRewardTokens,
} from "@/lib/reward-token-cookie"

// The generator each service maps back to, so a completed unlock returns the user to
// the page they came from.
function generatorHref(service: Service): string {
  return service === "prime"
    ? "/prime/account-generator"
    : service === "crunchyroll"
      ? "/crunchyroll/account-generator"
      : "/netflix"
}

function asService(value: unknown): Service {
  return value === "prime" ? "prime" : value === "crunchyroll" ? "crunchyroll" : "netflix"
}

// Starts the dedicated Access Pass unlock. Mints a purpose='pass' reward session and
// sends the user through the SAME gateway the generators used to use. On genuine
// completion the gateway flips the session's unlocked flag and returns to
// /reward-callback, which grants a 24h device pass and hands out NO account. After
// that the generators run gateway-free for 24h (still under the per-service limits).
//
// If the device already holds a valid pass we skip straight to the generator — no need
// to make a pass holder pass the gate again.
export async function redeemUnlockCode(formData: FormData): Promise<void> {
  const service = asService(formData.get("service"))
  const code = String(formData.get("accessCode") ?? "")
  const deviceId = await getOrCreateDeviceId()
  const ip = await requestIp()
  const redemptionLimit = await consumeAccessCodeRedemption(ip, deviceId)
  if (!redemptionLimit.success) {
    const retryAfter = Math.max(1, Math.ceil((redemptionLimit.reset - Date.now()) / 1000))
    redirect(`/unlock?service=${service}&error=${encodeURIComponent(`Too many redemption attempts. Try again in ${retryAfter} seconds.`)}`)
  }
  const result = await redeemAccessCode(code, deviceId)
  if (!result.ok) redirect(`/unlock?service=${service}&error=${encodeURIComponent(result.error)}`)
  const { grantLifetimePass, grantPass } = await import("@/lib/access-pass")
  const existingPass = result.accessType === "temporary" ? await getPass(deviceId) : null
  const granted = result.accessType === "temporary"
    ? (existingPass?.valid ? existingPass.expiresAt ?? Date.now() + 1 : await grantPass(deviceId, result.codeId))
    : await grantLifetimePass(deviceId, result.codeId)
  if (!granted) redirect(`/unlock?service=${service}&error=${encodeURIComponent("Access code storage is unavailable. Please try again.")}`)
  redirect(generatorHref(service) + (result.accessType === "temporary" ? "?access=code&temporary=true" : "?access=code&lifetime=true"))
}

async function startUnlockInternal(formData: FormData): Promise<void> {
  const service = asService(formData.get("service"))

  // Netflix is always protected by the 24-hour pass. Other services retain the
  // admin-controlled feature toggle used by their existing generator flows.
  if (service !== "netflix" && !(await isAccessPassMode())) redirect(generatorHref(service))

  const ip = await requestIp()
  const deviceId = await getOrCreateDeviceId()

  // Already unlocked → don't gate a valid pass holder again.
  if (deviceId && (await getPass(deviceId)).valid) redirect(generatorHref(service))

  const unlockLimit = await consumeUnlockStart(ip, deviceId)
  if (!unlockLimit.success) {
    const retryAfter = Math.max(1, Math.ceil((unlockLimit.reset - Date.now()) / 1000))
    redirect(`/unlock?service=${service}&error=${encodeURIComponent(`Too many unlock attempts. Try again in ${retryAfter} seconds.`)}`)
  }

  // Pass-only session: no plan/country, purpose='pass'. `service` is remembered so
  // /reward-callback can send the user back to the right generator after success.
  const token = await createRewardSession(null, null, service, { purpose: "pass" })

  const store = await cookies()
  const existing = parseRewardTokens(store.get(REWARD_TOKEN_COOKIE)?.value)
  store.set(REWARD_TOKEN_COOKIE, serializeRewardTokens(token, existing), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: REWARD_TOKEN_MAX_AGE,
  })

  // The NF checker always uses the configured ShortXLinks API on unlock.
  // This bypasses the admin provider chain so the 24-hour pass starts through
  // SHORTXLINKS_NF_API every time the user clicks the unlock button.
  let gatewayUrl: string
  try {
    gatewayUrl = await buildGatewayUrl(token, ip, process.env.SHORTXLINKS_NF_API, true)
  } catch (error) {
    console.error("[v0] NF ShortXLinks unlock failed", error)
    redirect(`/unlock?service=netflix&error=${encodeURIComponent("The NF unlock gateway is temporarily unavailable. Please try again.")}`)
  }
  redirect(gatewayUrl)
}

export async function startUnlock(formData: FormData): Promise<void> {
  try {
    await startUnlockInternal(formData)
  } catch (error) {
    unstable_rethrow(error)
    console.error("[v0] NF unlock action failed", error)
    redirect(`/unlock?service=netflix&error=${encodeURIComponent("Unlock is temporarily unavailable. Please try again.")}`)
  }
}

