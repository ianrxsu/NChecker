import { createHmac, timingSafeEqual } from "node:crypto"
import { redis, redisEnabled } from "./redis"

// ShrinkEarn gateway helpers.
//
// ShrinkEarn is a URL shortener with NO server-to-server completion postback, so
// unlike LootLabs we can't be told "the user genuinely finished". The strongest
// gate the mechanism allows is a one-time, HMAC-SIGNED destination link:
//
//   1. On start we mint a reward token (pending) and build a signed return URL
//      that encodes the token, the mint time, and an expiry. The HMAC makes it
//      unforgeable — nobody can fabricate a valid /shrinkearn/return URL.
//   2. We shorten THAT signed URL via ShrinkEarn's API and send the user to the
//      short link, so the real destination is only revealed after the gateway.
//   3. On return we verify the signature + expiry, enforce a MINIMUM dwell time
//      (a return faster than the ad interstitial realistically takes is a skip),
//      then unlock the session through the same single-use DB guard as LootLabs.
//
// The signed mint time travels IN the link (and is covered by the HMAC), so the
// dwell-time check is stateless and equally unforgeable — no extra DB read.

// Minimum seconds between minting the link and returning through it. A genuine
// ShrinkEarn pass walks the user through timed ad steps that take well over this;
// an instant return means the destination was hit directly or via a bypass tool.
// Kept conservative so slow-but-real completions are never falsely rejected.
export const SHRINKEARN_MIN_DWELL_SECONDS = 8

// How long a signed return link stays valid after minting. Matches the reward
// token cookie lifetime — long enough to complete, short enough to limit replay.
export const SHRINKEARN_LINK_TTL_SECONDS = 60 * 60

// The signing secret. Reuses the same server secret family as the signed device
// id so no new env var is strictly required, but a dedicated
// SHRINKEARN_SIGNING_SECRET can be set to rotate it independently.
function signingSecret(): string {
  return (
    process.env.SHRINKEARN_SIGNING_SECRET ||
    process.env.REWARD_SIGNING_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.ADMIN_PASSWORD ||
    "cookies-mo-shrinkearn-v1"
  )
}

// Deterministic HMAC over the exact payload the return route re-derives. Hex so it
// is URL-safe without extra encoding.
export function signShrinkEarn(token: string, mint: number, exp: number): string {
  return createHmac("sha256", signingSecret()).update(`${token}.${mint}.${exp}`).digest("hex")
}

// Constant-time signature comparison (avoids leaking validity via timing).
export function verifyShrinkEarnSig(token: string, mint: number, exp: number, sig: string): boolean {
  const expected = signShrinkEarn(token, mint, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Builds the absolute, signed, single-use return URL that ShrinkEarn will point at
// once the user finishes. `origin` is this deployment's own origin.
export function buildShrinkEarnReturnUrl(origin: string, token: string): string {
  const mint = Math.floor(Date.now() / 1000)
  const exp = mint + SHRINKEARN_LINK_TTL_SECONDS
  const sig = signShrinkEarn(token, mint, exp)
  const qs = new URLSearchParams({ t: token, m: String(mint), e: String(exp), s: sig })
  return `${origin}/api/shrinkearn/return?${qs.toString()}`
}

// ── Per-IP daily cap ──────────────────────────────────────────────────────────
// ShrinkEarn only PAYS for the first view per IP per 24h. So once an IP has
// genuinely completed a ShrinkEarn link, sending that same IP through ShrinkEarn
// again within the day earns nothing. We record the completion with a 24h TTL and,
// while it's live, the start action routes that IP through LootLabs instead (which
// still pays and is unbypassable). The window is a rolling 24h FROM completion —
// exactly ShrinkEarn's own cooldown — because the key simply expires 24h later.

const DAILY_TTL_SECONDS = 24 * 60 * 60
const dailyKey = (ip: string) => `shrinkearn:daily:${ip}`

// Marks that this IP just completed a ShrinkEarn link. Best-effort: a storage blip
// must never break the unlock, it only means we might route one extra unpaid view.
export async function markShrinkEarnCompleted(ip: string | null): Promise<void> {
  if (!ip || !redisEnabled) return
  try {
    await redis.set(dailyKey(ip), Date.now(), { ex: DAILY_TTL_SECONDS })
  } catch {
    /* observability/best-effort only */
  }
}

// ADMIN TESTING AID — clears this IP's 24h ShrinkEarn cooldown so the admin's own
// device is routed back through ShrinkEarn immediately instead of the LootLabs
// fallback. Best-effort; returns true if a key was removed.
export async function resetShrinkEarnCooldown(ip: string | null): Promise<boolean> {
  if (!ip || !redisEnabled) return false
  try {
    return (await redis.del(dailyKey(ip))) > 0
  } catch {
    return false
  }
}

// True while this IP is inside its 24h ShrinkEarn cooldown (already earned today).
// Fails OPEN (returns false → allow ShrinkEarn) on storage errors so a blip never
// blocks monetization; the worst case is one unpaid view, not a broken gate.
export async function isShrinkEarnOnCooldown(ip: string | null): Promise<boolean> {
  if (!ip || !redisEnabled) return false
  try {
    return (await redis.exists(dailyKey(ip))) === 1
  } catch {
    return false
  }
}

export type ShortenResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

// Calls ShrinkEarn's Quick Link API to shorten the signed destination. Requires
// SHRINKEARN_API_TOKEN. Returns a typed result so the caller can fail CLOSED
// (never hand out a reward) if shortening is misconfigured or unavailable.
export async function shortenWithShrinkEarn(destinationUrl: string): Promise<ShortenResult> {
  const apiToken = process.env.SHRINKEARN_API_TOKEN
  if (!apiToken) return { ok: false, error: "not_configured" }

  const endpoint = `https://shrinkearn.com/api?api=${encodeURIComponent(apiToken)}&url=${encodeURIComponent(
    destinationUrl,
  )}`

  try {
    // Don't let a slow shortener hang the generator start action indefinitely.
    const res = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    const data = (await res.json().catch(() => null)) as
      | { status?: string; shortenedUrl?: string; message?: string }
      | null
    const shortUrl = data?.shortenedUrl
    if (data?.status === "success" && typeof shortUrl === "string" && /^https?:\/\//.test(shortUrl)) {
      return { ok: true, url: shortUrl }
    }
    return { ok: false, error: data?.message || "shorten_failed" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "shorten_error" }
  }
}
