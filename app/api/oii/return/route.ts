import { NextResponse } from "next/server"
import { markRewardUnlocked } from "@/lib/reward-store"
import { verifyOiiSignature } from "@/lib/oii"
import {
  REWARD_TOKEN_COOKIE,
  REWARD_TOKEN_MAX_AGE,
  parseRewardTokens,
  serializeRewardTokens,
} from "@/lib/reward-token-cookie"

// oii.io RETURN endpoint — the destination our oii.io short link points at.
//
// oii.io is a shortener with no server-to-server postback (see lib/oii.ts), so this
// return is triggered by the user's own browser after passing the oii.io link. It is
// hardened as far as that model allows:
//   1. SIGNATURE  — the URL carries an HMAC over the reward token; forged or tampered
//                   links fail verification, so a user can't skip straight to the
//                   reward callback with an arbitrary token.
//   2. SINGLE-USE — unlocking goes through the SAME markRewardUnlocked guard as
//                   LootLabs/ShrinkEarn, and /reward-callback consumes atomically, so
//                   a link can grant at most one account and only once (the signature
//                   doubles as the replay key via the lootlabs_unique_id UNIQUE index).
//
// Unlike ShrinkEarn there is NO 24h per-IP cooldown — this behaves "like LootLabs":
// the same IP can pass oii.io repeatedly.

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  return fwd ? fwd.split(",")[0]!.trim() : null
}

function reject(origin: string, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/account-generator?error=${reason}`, origin), { status: 303 })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const origin = url.origin
  const params = url.searchParams

  const token = (params.get("token") ?? "").trim()
  // ROBUSTNESS: sig is the LAST param, and some ad-shorteners append their own
  // tracking suffix to the destination tail (e.g. ...&sig=<hmac>&ref=oii or a stray
  // ?utm=..). signOiiToken() always emits exactly 32 lowercase hex chars, so we
  // extract only that leading hex run — otherwise oii-appended junk would corrupt
  // the signature and the link could NEVER complete. Anything shorter/non-hex fails.
  const rawSig = (params.get("sig") ?? "").trim()
  const sig = rawSig.match(/^[0-9a-f]{32}/)?.[0] ?? ""

  if (!token || !sig) return reject(origin, "gateway")

  // 1. Unforgeable signature over the reward token.
  if (!verifyOiiSignature(token, sig)) return reject(origin, "gateway")

  // 2. Unlock via the shared single-use guard. The signature is unique per token, so
  //    it serves as the replay key — a re-hit of the same link can't unlock twice.
  const ip = clientIp(req)
  await markRewardUnlocked(token, sig, ip)
  void import("@/lib/metrics").then(({ recordGatewayCompletion }) => recordGatewayCompletion())

  // Forward to the callback (atomic consume + distribution) and refresh the recent-
  // token cookie so the callback finds this token even if the original mint cookie
  // was dropped crossing the shortener.
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
