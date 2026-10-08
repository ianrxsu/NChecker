import { NextResponse } from "next/server"
import { markRewardUnlocked } from "@/lib/reward-store"
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

  await markRewardUnlocked(token, sig, clientIp(req))

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
