import { NextResponse } from "next/server"
import { consumeTelegramWebsiteLoginToken } from "@/lib/telegram-login"
import { getOrCreateDeviceId, restoreDeviceId } from "@/lib/device-id"
import { redis, redisEnabled } from "@/lib/redis"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const telegramUserId = await consumeTelegramWebsiteLoginToken(url.searchParams.get("token") ?? "")
  if (!telegramUserId) {
    return NextResponse.redirect(new URL("/account-generator?telegram_login=expired", request.url))
  }

  const response = NextResponse.redirect(new URL("/account-generator?telegram_login=success", request.url))
  const existingWebsiteDeviceId = redisEnabled
    ? await redis.get<string>(`telegram:website-device:${telegramUserId}`)
    : null
  const websiteDeviceId = existingWebsiteDeviceId
    ? await restoreDeviceId(existingWebsiteDeviceId)
    : await getOrCreateDeviceId()
  if (redisEnabled && websiteDeviceId) {
    await redis.set(`telegram:website-device:${telegramUserId}`, websiteDeviceId, { ex: 60 * 60 * 24 * 365 })
    await redis.del(`logout:telegram:${telegramUserId}`)
  }
  // Remove the legacy parent-domain cookie before writing one canonical cookie
  // for cookiesmo.i4n.tech. This avoids duplicate cookies being selected
  // differently by pages and server actions.
  response.cookies.set("cm_telegram_subject", "", {
    domain: ".i4n.tech",
    path: "/",
    maxAge: 0,
  })
  response.cookies.set("cm_telegram_subject", telegramUserId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    // Keep the Telegram-linked website login across browser restarts for one year.
    // It is cleared only when the user explicitly logs out or the token is replaced.
    maxAge: 60 * 60 * 24 * 365,
  })
  return response
}
