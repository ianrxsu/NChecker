import { redis, redisEnabled } from "./redis"
import { getCachedConfig, bustConfigCache } from "./config-cache"

// "Access Pass" mode. An admin-controlled alternative to per-claim gating:
//
//   OFF (default) → every account requires passing the gateway link (today's
//                   behavior; nothing changes).
//   ON            → a user passes ONE gateway link once, earning a 24h "pass"
//                   bound to their signed device id. During those 24h they use
//                   every generator (Netflix / Prime / Crunchyroll) WITHOUT the
//                   gateway — still bound by the admin's per-service claim limits.
//                   After 24h the pass expires and they must pass the link again.
//
// We reuse the entire existing reward pipeline: in pass mode the start action mints
// the reward_sessions row ALREADY unlocked (only ever after a server-side valid-pass
// check) and skips the gateway redirect; distribution + limits are untouched.

// 24 hours. The window is anchored to the FIRST genuine gateway completion (see
// grantPass — it uses SET NX so repeat claims inside the window never extend it).
export const PASS_TTL_SECONDS = 24 * 60 * 60

// ── Mode toggle (admin) ──────────────────────────────────────────────────────
// Low-cardinality, read on generator page loads / start actions, so it's fronted
// by the same short in-process cache as the other site config flags.
const MODE_KEY = "site:access-pass-mode"
const MODE_CACHE_KEY = "access-pass-mode"
const MODE_CACHE_TTL_MS = 30_000

// Is Access Pass mode enabled? Fails OPEN to false (i.e. today's per-claim gating)
// whenever Redis is down/unset — a flaky DB must never accidentally give away the
// gateway. Fail-safe toward the paying gate.
export async function isAccessPassMode(): Promise<boolean> {
  if (!redisEnabled) return false
  return getCachedConfig(MODE_CACHE_KEY, MODE_CACHE_TTL_MS, async () => {
    try {
      return Boolean(await redis.get<boolean>(MODE_KEY))
    } catch {
      return false
    }
  })
}

// Persists the mode. Like the other WRITE paths, this does NOT swallow failures:
// if the admin's change didn't persist they must know. Busts this instance's cache
// so the admin sees the change immediately; others converge within the TTL.
export async function setAccessPassMode(next: boolean): Promise<boolean> {
  if (!redisEnabled) {
    throw new Error("Storage is not configured, so Access Pass mode can't be saved.")
  }
  await redis.set(MODE_KEY, next)
  bustConfigCache(MODE_CACHE_KEY)
  return next
}

// ── Per-device pass ──────────────────────────────────────────────────────────
// A single gateway completion earns a 24h pass anchored ONLY to the signed,
// HTTP-only device id. This is deliberately DEVICE-ONLY (not IP):
//
//   • The pass GRANTS free access (it lets a user skip the gateway). If it were
//     also anchored to the IP, then ONE person completing the ShrinkEarn link would
//     unlock EVERYONE sharing that public IP — carrier-grade NAT, home Wi-Fi, a
//     shared VPN — so users who never did the link would get in for free. That is
//     exactly the leak we must avoid: a user is only unlocked if THEIR device
//     completed the link.
//   • Anti-abuse still lives elsewhere: the per-service CLAIM limits in
//     lib/rate-limit are enforced on IP AND device, unchanged. The pass only decides
//     "gateway vs no gateway", never how many accounts can be taken.
//   • Clearing cookies drops the device id and therefore the pass, so the user must
//     pass the link again — strictly MORE restrictive, which is the safe direction.
//
// NOT cached — per-user and must always be fresh; only read on page loads / starts.
function passKey(deviceId: string): string {
  return `pass:${deviceId}`
}

export type PassState = { valid: boolean; expiresAt: number | null; accessCodeId?: number }

// Grants the 24h pass for this device, anchored to now via SET ... NX EX so it only
// creates the window when one doesn't already exist — repeat claims inside the 24h
// are no-ops that can NEVER silently extend it. Returns the effective expiry (the
// existing value when NX was a no-op), or null on empty id / Redis down / error.
export async function grantPass(deviceId: string, codeId?: number): Promise<number | null> {
  if (!redisEnabled || !deviceId) return null
  const expiresAt = Date.now() + PASS_TTL_SECONDS * 1000
  try {
    const created = await redis.set(passKey(deviceId), codeId ? `temporary:${codeId}:${expiresAt}` : expiresAt, { nx: true, ex: PASS_TTL_SECONDS })
    if (created) return expiresAt
    const existing = await redis.get<number | string>(passKey(deviceId))
    if (typeof existing === "number") return existing
    if (typeof existing === "string" && existing.startsWith("temporary:")) {
      const expiresAt = Number(existing.split(":")[2])
      return expiresAt > Date.now() ? expiresAt : null
    }
    return null
  } catch {
    return null
  }
}

// Reads this device's pass. Valid only when the device's own key exists AND is still
// in the future. Fails to invalid (→ gateway), which is the fail-safe direction, so a
// user with no device id (or a Redis blip) is treated as locked and must do the link.
// Grants permanent access for a redeemed lifetime code. The key has no TTL and
// remains bound to the same signed device id until an admin or database action clears it.
export async function grantLifetimePass(deviceId: string, codeId?: number): Promise<boolean> {
  if (!redisEnabled || !deviceId) return false
  try {
    await redis.set(passKey(deviceId), codeId ? `lifetime:${codeId}` : "lifetime")
    return true
  } catch {
    return false
  }
}

export async function revokeLifetimePass(deviceId: string): Promise<boolean> {
  if (!redisEnabled || !deviceId) return false
  try {
    await redis.del(passKey(deviceId))
    return true
  } catch {
    return false
  }
}

export async function getPass(deviceId: string): Promise<PassState> {
  if (!redisEnabled || !deviceId) return { valid: false, expiresAt: null }
  try {
    const val = await redis.get<number | string>(passKey(deviceId))
    if (val === "lifetime") return { valid: true, expiresAt: null }
    if (typeof val === "string" && val.startsWith("lifetime:")) return { valid: true, expiresAt: null, accessCodeId: Number(val.slice(9)) || undefined }
    if (typeof val === "string" && val.startsWith("temporary:")) {
      const [, codeId, expiry] = val.split(":")
      const expiresAt = Number(expiry)
      if (expiresAt > Date.now()) return { valid: true, expiresAt, accessCodeId: Number(codeId) || undefined }
    }
    if (typeof val === "number" && val > Date.now()) return { valid: true, expiresAt: val }
    return { valid: false, expiresAt: null }
  } catch {
    return { valid: false, expiresAt: null }
  }
}

// ── Per-IP pass-mint cap (defense in depth) ──────────────────────────────────
// The pass is DEVICE-scoped, so the cheapest abuse is "clear cookies → get a fresh
// device id → complete the gateway again → mint another pass", repeated in a loop to
// farm many simultaneous 24h passes from one machine. Each loop still costs a real
// gateway completion (so it isn't free), and the per-service CLAIM limits already cap
// output on the IP side — but we add a per-IP ceiling on how many DISTINCT device
// passes may be minted per rolling 24h as a cheap extra brake on scripted farming.
//
// Deliberately GENEROUS: shared public IPs (carrier-grade NAT, school/office Wi-Fi,
// VPN exit nodes) legitimately host many different people who each complete the
// gateway on their own device, so a tight cap would lock out real users. 20/day/IP
// sits well above realistic shared-IP demand yet still stops a runaway mint loop.
// Fails OPEN (allowed) on any Redis error — a limiter blip must never wrongly refuse
// a genuine unlock the user already did the gateway work for.
const PASS_MINTS_PER_IP_PER_DAY = 20

function passMintKey(ip: string): string {
  return `pass-mint:${ip}`
}

// PEEK ONLY — never mutates. True while this IP is still under its daily pass-mint
// ceiling. Call before granting a pass on the /unlock path.
export async function passMintAllowed(ip: string): Promise<boolean> {
  if (!redisEnabled || !ip) return true
  try {
    const used = Number((await redis.get<number>(passMintKey(ip))) ?? 0) || 0
    return used < PASS_MINTS_PER_IP_PER_DAY
  } catch {
    return true
  }
}

// Charges ONE pass-mint against this IP's rolling-24h window. Called only after a
// genuine pass grant. The TTL is set once (on the first mint) and never refreshed,
// so the window is anchored to the first mint and auto-clears 24h later.
export async function recordPassMint(ip: string): Promise<void> {
  if (!redisEnabled || !ip) return
  try {
    const count = await redis.incr(passMintKey(ip))
    if (count === 1) await redis.expire(passMintKey(ip), PASS_TTL_SECONDS)
  } catch {
    // Best-effort — a limiter hiccup must never wedge a genuine unlock.
  }
}
