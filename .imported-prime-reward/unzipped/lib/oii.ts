// oii.io gateway helpers.
//
// IMPORTANT: oii.io is a LINK SHORTENER API (same shape as ShrinkEarn), NOT a
// LootLabs-style postback locker. Its API is:
//   GET https://oii.io/api?api=<TOKEN>&url=<DESTINATION>&format=text
// which returns a short link. There is no server-to-server postback, so we cannot
// verify completion the way LootLabs does.
//
// To get as close to "treat it like LootLabs" (no 24h per-IP limit) as oii.io's
// real API allows, we reuse the SIGNED RETURN URL trick from ShrinkEarn: the
// destination we shorten is our own /api/oii/return?token=..&sig=.. link. The sig
// is an HMAC of the token, so a user cannot skip the shortener and hit the reward
// callback directly — they must pass through the oii.io short link, which lands on
// our signed return route, which marks the reward unlocked. Unlike ShrinkEarn there
// is NO 24h cooldown check, so a given IP can pass oii.io repeatedly.

import { createHmac, timingSafeEqual } from "node:crypto"

const OII_API = "https://oii.io/api"

// Signing key for the return URL. Reuses REWARD_TOKEN_SECRET so no extra env var is
// needed; the oii return route verifies with the same key.
function signingKey(): string {
  return process.env.REWARD_TOKEN_SECRET || process.env.SHRINKEARN_API_TOKEN || ""
}

// HMAC-SHA256 of the reward token, hex-encoded and trimmed — the return signature.
export function signOiiToken(token: string): string {
  return createHmac("sha256", signingKey()).update(token).digest("hex").slice(0, 32)
}

// Constant-time signature verification for the return route.
export function verifyOiiSignature(token: string, sig: string): boolean {
  const expected = signOiiToken(token)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Builds our own signed return URL that oii.io will ultimately redirect the user to.
export function buildOiiReturnUrl(origin: string, token: string): string {
  const sig = signOiiToken(token)
  return `${origin}/api/oii/return?token=${encodeURIComponent(token)}&sig=${sig}`
}

// Calls the oii.io shortener API to wrap our signed return URL in an oii.io short
// link. Returns { ok:true, url } on success, { ok:false } on any error so callers
// can fail SAFE back to LootLabs.
export async function shortenWithOii(
  destinationUrl: string,
): Promise<{ ok: true; url: string } | { ok: false }> {
  const token = process.env.OII_API_TOKEN
  if (!token) return { ok: false }
  try {
    const api = `${OII_API}?api=${encodeURIComponent(token)}&url=${encodeURIComponent(
      destinationUrl,
    )}&format=text`
    const res = await fetch(api, { cache: "no-store" })
    if (!res.ok) return { ok: false }
    const text = (await res.text()).trim()
    // TEXT format returns just the short link on success, or an error message.
    if (!/^https?:\/\/\S+$/.test(text)) return { ok: false }
    return { ok: true, url: text }
  } catch (err) {
    console.log("[v0] oii.io shorten failed:", (err as Error)?.message)
    return { ok: false }
  }
}

// Whether oii.io is usable — requires an API token and a signing key for returns.
export function oiiConfigured(): boolean {
  return Boolean(process.env.OII_API_TOKEN && signingKey())
}
