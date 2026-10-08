import { NextResponse } from "next/server"
import { markRewardUnlocked } from "@/lib/reward-store"
import {
  verifyShrinkEarnSig,
  SHRINKEARN_MIN_DWELL_SECONDS,
  markShrinkEarnCompleted,
} from "@/lib/shrinkearn"
import {
  REWARD_TOKEN_COOKIE,
  REWARD_TOKEN_MAX_AGE,
  parseRewardTokens,
  serializeRewardTokens,
} from "@/lib/reward-token-cookie"

// ShrinkEarn RETURN endpoint — the destination our signed short link points at.
//
// ShrinkEarn has no server-to-server postback, so this return is triggered by the
// user's own browser after the ad interstitial. It is hardened as far as that
// model allows (all four checks must pass before a session is unlocked):
//   1. SIGNATURE  — the URL carries an HMAC over token+mint+expiry; forged or
//                   tampered links fail verification.
//   2. EXPIRY     — links older than their signed expiry are rejected.
//   3. DWELL TIME — a return arriving faster than the ad interstitial realistically
//                   takes (SHRINKEARN_MIN_DWELL_SECONDS) is treated as a direct-URL
//                   skip / bypass-tool hit and rejected.
//   4. SINGLE-USE — unlocking goes through the SAME markRewardUnlocked guard as
//                   LootLabs, and /reward-callback still consumes atomically, so a
//                   link can grant at most one account and only once.
// The signature doubles as the replay key (unique per mint) via the existing
// lootlabs_unique_id UNIQUE index, so re-hitting a used link can't unlock again.

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  return fwd ? fwd.split(",")[0]!.trim() : null
}

// All rejections bounce back to the generator with a reason the page can surface,
// rather than leaking why the check failed to a would-be bypasser.
function reject(origin: string, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/account-generator?error=${reason}`, origin), { status: 303 })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const origin = url.origin
  const params = url.searchParams

  const token = (params.get("t") ?? "").trim()
  const mint = Number(params.get("m"))
  const exp = Number(params.get("e"))
  const sig = (params.get("s") ?? "").trim()

  if (!token || !sig || !Number.isFinite(mint) || !Number.isFinite(exp)) {
    return reject(origin, "gateway")
  }

  // 1. Unforgeable signature over the exact minted payload.
  if (!verifyShrinkEarnSig(token, mint, exp, sig)) return reject(origin, "gateway")

  const nowSec = Math.floor(Date.now() / 1000)

  // 2. Expired signed link.
  if (nowSec > exp) return reject(origin, "expired")

  // 3. Anti-skip dwell gate: too fast to have genuinely passed the interstitial.
  //    (Also rejects a negative/future mint from a tampered-but-somehow-signed URL.)
  if (nowSec - mint < SHRINKEARN_MIN_DWELL_SECONDS) return reject(origin, "toofast")

  // 4. Unlock via the shared single-use guard. The signature is unique per mint, so
  //    it serves as the replay key — a re-hit of the same link can't unlock twice.
  const ip = clientIp(req)
  await markRewardUnlocked(token, sig, ip)

  // Record this IP's ShrinkEarn completion so the start action routes it through
  // LootLabs for the next 24h (ShrinkEarn only pays one view per IP per day).
  await markShrinkEarnCompleted(ip)

  // Forward to the callback (which performs the atomic consume + distribution) and
  // refresh the recent-token cookie so the callback finds this token even if the
  // original mint cookie was dropped crossing the shortener.
  const res = NextResponse.redirect(new URL(`/reward-callback?r=${encodeURIComponent(token)}`, origin), {
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
