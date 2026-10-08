import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { redis, redisEnabled } from "@/lib/redis"
import { clearFreeClaimBuckets, grantNetflixExtension } from "@/lib/rate-limit"
import { getClaimLimits } from "@/lib/claim-limits"
import { grantPass } from "@/lib/access-pass"
import {
  SHORTXLINKS_MIN_DWELL_SECONDS,
  verifyShortXLinksSig,
} from "@/lib/shortxlinks"
import {
  REWARD_TOKEN_COOKIE,
  REWARD_TOKEN_MAX_AGE,
  parseRewardTokens,
  serializeRewardTokens,
} from "@/lib/reward-token-cookie"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")
  return forwarded ? forwarded.split(",")[0]!.trim() : null
}

function reject(origin: string, reason = "gateway"): NextResponse {
  return NextResponse.redirect(new URL(`/account-generator?error=${reason}`, origin), { status: 303 })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const params = url.searchParams
  const token = (params.get("t") ?? "").trim()
  const mint = Number.parseInt(params.get("m") ?? "", 10)
  const exp = Number.parseInt(params.get("e") ?? "", 10)
  const sig = (params.get("s") ?? "").trim().match(/^[0-9a-f]{64}/)?.[0] ?? ""
  const now = Math.floor(Date.now() / 1000)

  if (!token || !sig || !Number.isSafeInteger(mint) || !Number.isSafeInteger(exp)) return reject(url.origin)
  if (exp <= now || mint > now || now - mint < SHORTXLINKS_MIN_DWELL_SECONDS) return reject(url.origin)
  if (!verifyShortXLinksSig(token, mint, exp, sig)) return reject(url.origin)

  let telegramPending: { chatId: string; userId: string; service: string } | null = null
  try {
    telegramPending = redisEnabled ? await redis.get<{ chatId: string; userId: string; service: string }>(`telegram:shortx:pending:${token}`) : null
  } catch (error) {
    console.error("[shortxlinks] Telegram pending lookup failed", error)
  }
  const webExtensionPending = redisEnabled
    ? await redis.get<{ deviceId: string }>(`web:netflix-extension:pending:${token}`)
    : null
  if (webExtensionPending?.deviceId) {
    const claimed = await redis.set(`web:netflix-extension:consumed:${token}`, "1", { nx: true, ex: 3600 })
    if (!claimed) return NextResponse.redirect(new URL("/account-generator?unlock=error", url.origin), { status: 303 })
    const limits = await getClaimLimits()
    const granted = await grantNetflixExtension(webExtensionPending.deviceId, limits.netflix.limit, limits.netflix.windowSeconds)
    if (granted) void import("@/lib/daily-completion-stats").then(({ incrementDailyCompletion }) => incrementDailyCompletion("extension"))
    await redis.del(`web:netflix-extension:pending:${token}`, `web:netflix-extension:active:${webExtensionPending.deviceId}`)
    return NextResponse.redirect(new URL(`/account-generator?unlock=${granted ? "success" : "error"}`, url.origin), { status: 303 })
  }

  if (telegramPending) {
    // Claim the signed gateway token atomically before granting access. This
    // prevents two concurrent/replayed callbacks from both minting Telegram access.
    const consumedKey = `telegram:shortx:consumed:${token}`
    const claimed = await redis.set(consumedKey, telegramPending.userId, { nx: true, ex: 3600 })
    if (!claimed) return NextResponse.redirect("https://t.me/cookiesmo_bot", { status: 303 })
    const accessKey = `telegram:shortx:daily:${telegramPending.userId}`
    const deviceId = `telegram:${createHash("sha256").update(telegramPending.userId).digest("hex")}`
    const existingAccess = await redis.get(accessKey)
    if (!existingAccess) {
      await clearFreeClaimBuckets(deviceId, ["netflix", "prime", "crunchyroll"])
    }
    const passExpiresAt = await grantPass(deviceId)
    if (!passExpiresAt) {
      console.error("[shortxlinks] Telegram access pass could not be granted")
      return reject(url.origin, "telegram_access")
    }
    await redis.set(accessKey, String(passExpiresAt), { ex: 86400 })
    await redis.incr("telegram:stats:unlocks")
    void import("@/lib/daily-completion-stats").then(({ incrementDailyCompletion }) => incrementDailyCompletion("telegram"))
    await redis.del(`telegram:shortx:pending:${token}`, `telegram:shortx:active:${telegramPending.userId}`)
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (botToken) {
      const confirmation = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: telegramPending.chatId, text: "Access completed. You now have access to the bot for 24 hours. Your normal claim limits still apply.", reply_markup: { inline_keyboard: [[{ text: "Back to Main Menu", callback_data: "command:start" }]] } }), cache: "no-store" }).then((response) => response.json() as Promise<{ result?: { message_id?: number } }>).catch(() => null)
      const messageId = confirmation?.result?.message_id
      if (typeof messageId === "number") {
        const ids = (await redis.get<number[]>(`telegram:interactions:${telegramPending.chatId}`)) || []
        await redis.set(`telegram:interactions:${telegramPending.chatId}`, [...new Set([...ids, messageId])].slice(-100), { ex: 86400 })
      }
    }
    return NextResponse.redirect("https://t.me/cookiesmo_bot", { status: 303 })
  }

  const { markRewardUnlocked } = await import("@/lib/reward-store")
  await markRewardUnlocked(token, sig, clientIp(req))
  void import("@/lib/metrics").then(({ recordGatewayCompletion }) => recordGatewayCompletion())

  const res = NextResponse.redirect(new URL(`/reward-callback?r=${encodeURIComponent(token)}`, url.origin), {
    status: 303,
  })
  const rawCookie = req.headers.get("cookie")?.match(/(?:^|;\s*)reward_token=([^;]+)/)?.[1]
  let existing: string[] = []
  if (rawCookie) {
    try {
      existing = parseRewardTokens(decodeURIComponent(rawCookie))
    } catch {
      existing = parseRewardTokens(rawCookie)
    }
  }
  res.cookies.set(REWARD_TOKEN_COOKIE, serializeRewardTokens(token, existing), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: REWARD_TOKEN_MAX_AGE,
  })
  return res
}
