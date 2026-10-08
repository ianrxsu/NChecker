import { Ratelimit } from "@upstash/ratelimit"
import { redis, redisEnabled } from "./redis"
import type { NextRequest } from "next/server"
import type { GeneratorService as Service } from "./check-via-proxies"
import { getClaimLimits, formatClaimLabel } from "./claim-limits"

// IP-based limiter. We count *cookies* (not requests) so the budget reflects real
// work. Lowered 50,000 → 4,000/min/IP: this is a COST guardrail (each cookie maps
// to a server-side check = Active-CPU/duration on Vercel), sized so a single IP
// can't spike invocations via a runaway loop or abusive script, while still being
// far above any normal interactive bulk run (4,000 cookies/min ≈ 240k/hr per IP).
// Genuine large lists stream over several minutes and stay comfortably under it;
// the server-side adaptive throttle still governs upstream politeness.
const COOKIE_CHECKS_PER_MINUTE = 4_000

const limiter = redisEnabled
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(COOKIE_CHECKS_PER_MINUTE, "60 s"),
      prefix: "rl:check",
      // analytics OFF: it wrote an extra Redis record on EVERY check, ~doubling this
      // limiter's command usage against the Upstash quota for data we never read.
      // This is purely a cost guardrail, so the raw limit check is all we need.
      analytics: false,
    })
  : null

// Strict limiter for admin login attempts to thwart brute force: 5 tries per
// minute per IP. Failed and successful attempts both count.
const loginLimiter = redisEnabled
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "60 s"),
      prefix: "rl:admin-login",
      analytics: false,
    })
  : null

// Lifetime-key redemption limiter. The key intentionally excludes the submitted code
// so attackers cannot bypass the limit by cycling through invalid codes.
const accessCodeRedeemLimiter = redisEnabled
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "10 m"),
      prefix: "rl:access-code-redeem",
      analytics: false,
    })
  : null

export async function consumeAccessCodeRedemption(ip: string, deviceId: string): Promise<RateLimitResult> {
  if (!accessCodeRedeemLimiter) {
    return { success: true, limit: 5, remaining: 5, reset: Date.now() }
  }
  try {
    const { success, limit, remaining, reset } = await accessCodeRedeemLimiter.limit(`${ip}:${deviceId}`)
    return { success, limit, remaining, reset }
  } catch (err) {
    console.log("[v0] consumeAccessCodeRedemption: Redis error, failing open:", (err as Error)?.message)
    return { success: true, limit: 5, remaining: 5, reset: Date.now() }
  }
}

export type RateLimitResult = {
  success: boolean
  limit: number
  remaining: number
  reset: number // epoch ms when the window resets
}

export async function consumeLoginAttempt(ip: string): Promise<RateLimitResult> {
  if (!loginLimiter) {
    return { success: true, limit: 5, remaining: 5, reset: Date.now() }
  }
  try {
    const { success, limit, remaining, reset } = await loginLimiter.limit(ip)
    return { success, limit, remaining, reset }
  } catch (err) {
    // Fail OPEN if Redis is unavailable/over-quota. A limiter outage must never lock
    // the admin out of their own panel; brute-force risk during a brief Redis blip
    // is the lesser evil than a hard lockout. Logged for visibility.
    console.log("[v0] consumeLoginAttempt: Redis error, failing open:", (err as Error)?.message)
    return { success: true, limit: 5, remaining: 5, reset: Date.now() }
  }
}

// ---------------------------------------------------------------------------
// Admin-login brute-force protection (FAILURE-ONLY, two-tier).
//
// This replaces the "count every attempt" model with one that only penalizes
// WRONG passwords, using manual Redis counters (peek + record) so:
//   • A legitimate admin logging in successfully never spends budget — only
//     failed guesses accumulate toward a lockout.
//   • Two windows run at once so a slow drip can't sidestep the fast window:
//       - burst : 5 failures / minute   (stops rapid scripted guessing)
//       - sustained : 20 failures / hour (stops slow, patient brute force)
//   • A visitor is blocked when EITHER window is exhausted; the reset returned is
//     whichever clears last, so the UI shows an honest countdown.
// Fails OPEN on any Redis error (never lock the real admin out over a blip).
// ---------------------------------------------------------------------------
const LOGIN_FAIL_WINDOWS = [
  { key: "burst", limit: 5, seconds: 60 },
  { key: "sustained", limit: 20, seconds: 60 * 60 },
] as const

function loginFailKey(window: string, ip: string): string {
  return `admin-login-fail:${window}:${ip}`
}

export type LoginGate = { allowed: boolean; resetMs: number }

// PEEK ONLY — never mutates. Call BEFORE checking the password to reject a client
// that has already burned through its failure budget in either window.
export async function loginAllowed(ip: string): Promise<LoginGate> {
  if (!redisEnabled || !ip) return { allowed: true, resetMs: Date.now() }
  let allowed = true
  let resetMs = Date.now()
  for (const w of LOGIN_FAIL_WINDOWS) {
    const key = loginFailKey(w.key, ip)
    try {
      const [used, ttlMs] = await Promise.all([
        redis.get<number>(key).then((v) => Number(v ?? 0) || 0),
        redis.pttl(key),
      ])
      if (used >= w.limit) {
        allowed = false
        const clears = ttlMs > 0 ? Date.now() + ttlMs : Date.now() + w.seconds * 1000
        resetMs = Math.max(resetMs, clears)
      }
    } catch {
      // Fail open for this window on a Redis hiccup.
      continue
    }
  }
  return { allowed, resetMs }
}

// Records ONE failed login against both windows. Called only after a wrong
// password, so correct logins cost nothing. TTL is set once per window (on the
// first failure) and never refreshed, so each window auto-clears on schedule.
export async function recordLoginFailure(ip: string): Promise<void> {
  if (!redisEnabled || !ip) return
  for (const w of LOGIN_FAIL_WINDOWS) {
    const key = loginFailKey(w.key, ip)
    try {
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, w.seconds)
    } catch {
      // Best-effort — a limiter hiccup must never wedge the login route.
    }
  }
}

// ---------------------------------------------------------------------------
// LootLabs postback abuse guard. The postback secret is high-entropy, so brute
// force is already infeasible — but a real LootLabs server NEVER sends a wrong
// secret, so any IP that submits invalid secrets is illegitimate by definition.
// We let it fail a few times (misconfiguration/probing) then block that IP for an
// hour, cutting off automated secret-guessing as cheap defense in depth. Fails
// OPEN so a Redis blip can never drop genuine completions.
// ---------------------------------------------------------------------------
const POSTBACK_REJECTS_PER_HOUR = 10

export async function postbackRejectAllowed(ip: string): Promise<boolean> {
  if (!redisEnabled || !ip) return true
  try {
    const used = Number((await redis.get<number>(`postback-reject:${ip}`)) ?? 0) || 0
    return used < POSTBACK_REJECTS_PER_HOUR
  } catch {
    return true
  }
}

export async function recordPostbackReject(ip: string): Promise<void> {
  if (!redisEnabled || !ip) return
  try {
    const count = await redis.incr(`postback-reject:${ip}`)
    if (count === 1) await redis.expire(`postback-reject:${ip}`, 60 * 60)
  } catch {
    // Best-effort.
  }
}

// Best-effort client IP. Vercel sets x-forwarded-for; fall back to a constant so
// the limiter still functions (shared bucket) if headers are stripped.
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]!.trim()
  return req.headers.get("x-real-ip")?.trim() || "unknown"
}

// ---------------------------------------------------------------------------
// Per-service ACCOUNT-CLAIM limits (free generator). These cap how many free
// accounts a single visitor can successfully unlock per fixed window, on top of
// the LootLabs gateway. They are about FAIRNESS/abuse (one person draining the
// pool), not raw request cost like the cookie-check limiter above.
//
// The actual numbers are ADMIN-CONFIGURABLE and stored in Redis — see
// lib/claim-limits.ts (defaults: Netflix 3/hour, Prime & Crunchyroll 2/day).
// We read the effective values via getClaimLimits() on each call so a change in
// the System tab takes effect instantly with no redeploy.
// ---------------------------------------------------------------------------

export type ClaimAllowance = {
  allowed: boolean
  limit: number
  remaining: number
  resetMs: number // epoch ms when this IP's window resets
  label: string // e.g. "3 per hour" — surfaced to the user when blocked
}

// Builds the claim bucket key for an identity. The key is STABLE (no time bucket in
// the name) so the window is anchored to the visitor's FIRST claim, not to a global
// clock boundary. The reset is derived from the key's live TTL (see claimAllowance),
// which is set to `windowSeconds` on the first claim and left untouched afterwards.
//   kind "ip"  → key claims:<service>:ip:<ip>
//   kind "dev" → key claims:<service>:dev:<deviceId>
//
// Previously the key embedded an epoch-aligned windowStart, so a "per day" cap reset
// at UTC midnight rather than 24h after the claim — e.g. claiming at 4pm showed an
// ~8h countdown (time until midnight). Anchoring to first claim fixes that for all
// services (Netflix 1h, Prime/Crunchyroll 24h).
type BucketKind = "ip" | "dev" | "fp"

function claimWindowKey(service: Service, kind: BucketKind, id: string): string {
  return `claims:${service}:${kind}:${id}`
}

// How much wider the IP bucket is than the per-device cap. The device + fingerprint
// buckets enforce the EXACT per-service limit (N); the IP bucket is a POOLED CEILING
// of N × this, so several genuinely-distinct devices on one shared network (roommates,
// office Wi-Fi) each keep their own N without the network as a whole being able to
// drain the pool. Tunable — raise it for very shared networks, lower it to clamp abuse.
const IP_CEILING_MULTIPLIER = 5

// Resolves a bucket's own cap from the service base limit N:
//   • dev / fp → N   (the real per-device limit; fp makes it survive id resets)
//   • ip       → N × IP_CEILING_MULTIPLIER (wide pooled ceiling)
function bucketLimit(kind: BucketKind, baseLimit: number): number {
  if (kind === "ip") return Math.max(1, Math.min(1000, Math.round(baseLimit * IP_CEILING_MULTIPLIER)))
  return baseLimit
}

// Builds the list of buckets to enforce against — the IP, the signed device id, and
// the server-computed fingerprint. Each is INDEPENDENT and the claim must be under
// its own cap on ALL present buckets. This is what makes the limit resistant to
// bypass: clearing cookies / reinstalling the extension yields a fresh DEVICE id but
// the FINGERPRINT bucket (which the client can't reset) is still full, and rotating
// the IP leaves both the device and fingerprint buckets full. A user must defeat all
// three on every claim.
function claimIdentities(
  kindIp: string,
  deviceId?: string,
  fingerprint?: string,
): Array<{ kind: BucketKind; id: string }> {
  const ids: Array<{ kind: BucketKind; id: string }> = []
  if (kindIp) ids.push({ kind: "ip", id: kindIp })
  if (deviceId) ids.push({ kind: "dev", id: deviceId })
  if (fingerprint) ids.push({ kind: "fp", id: fingerprint })
  return ids
}

// PEEK ONLY — never mutates. Tells the caller whether this visitor (IP + device)
// may unlock another account for `service` in the current window. A visitor is
// blocked if EITHER identity is at the cap. Fails OPEN (allowed) when Redis is
// unavailable so a genuine completion is never wrongly rejected.
export async function claimAllowance(
  service: Service,
  ip: string,
  deviceId?: string,
  fingerprint?: string,
  override?: { limit: number; windowSeconds: number },
): Promise<ClaimAllowance> {
  const { limit, windowSeconds } = override ?? (await getClaimLimits())[service]
  // Headline label/limit shown to the user reflect the PER-DEVICE cap (N) — that's the
  // number they understand ("2 per day"). The wider IP ceiling is an internal guardrail.
  const label = formatClaimLabel(limit, windowSeconds)
  const identities = claimIdentities(ip, deviceId, fingerprint)
  if (!redisEnabled || identities.length === 0) {
    return { allowed: true, limit, remaining: limit, resetMs: Date.now() + windowSeconds * 1000, label }
  }

  // Remaining is the MIN free slots across all buckets, clamped to the per-device cap
  // so the UI never shows more than N even though the IP ceiling is higher.
  let remaining = limit
  let allowed = true
  // When blocked, surface the LATEST reset among the exhausted buckets — that's the
  // soonest moment the visitor is actually free to claim again on every identity.
  let blockedResetMs = 0
  // Fallback reset used when nothing is blocked (a full window from now).
  let anyResetMs = Date.now() + windowSeconds * 1000

  for (const { kind, id } of identities) {
    const cap = bucketLimit(kind, limit)
    const key = claimWindowKey(service, kind, id)
    let used = 0
    let ttlMs = -2 // -2 = key missing, -1 = no expiry (mirrors Redis pttl)
    try {
      // Read the count and the remaining TTL together; the TTL is what tells us when
      // THIS visitor's window (anchored to their first claim) actually resets.
      ;[used, ttlMs] = await Promise.all([
        redis.get<number>(key).then((v) => Number(v ?? 0) || 0),
        redis.pttl(key),
      ])
    } catch {
      // Treat an unreachable bucket as empty (fail open for this identity).
      continue
    }
    // Convert TTL → epoch reset. Missing/expiring-less keys fall back to a full
    // window so we never show a stale or absurd countdown.
    const resetMs = ttlMs > 0 ? Date.now() + ttlMs : Date.now() + windowSeconds * 1000
    anyResetMs = resetMs
    // Clamp each bucket's free slots to the headline cap so a high IP ceiling can't
    // inflate the displayed remaining above N.
    remaining = Math.min(remaining, Math.max(0, Math.min(limit, cap - used)))
    if (used >= cap) {
      allowed = false
      blockedResetMs = Math.max(blockedResetMs, resetMs)
    }
  }

  return { allowed, limit, remaining, resetMs: allowed ? anyResetMs : blockedResetMs, label }
}

// Charges ONE slot against EVERY identity's window (IP and device). Called ONLY
// after an account is actually distributed, so a pending/failed/refresh claim
// never costs a slot.
export async function recordClaim(
  service: Service,
  ip: string,
  deviceId?: string,
  fingerprint?: string,
  override?: { windowSeconds: number },
): Promise<void> {
  const { windowSeconds } = override ?? (await getClaimLimits())[service]
  if (!redisEnabled) return
  for (const { kind, id } of claimIdentities(ip, deviceId, fingerprint)) {
    const key = claimWindowKey(service, kind, id)
    try {
      const count = await redis.incr(key)
      // Set the TTL exactly once (on the first increment) and never refresh it, so
      // the window stays anchored to the visitor's first claim and auto-clears
      // exactly `windowSeconds` later — that TTL is what claimAllowance reads back.
      if (count === 1) await redis.expire(key, windowSeconds)
    } catch {
      // Best-effort — a metrics/limiter hiccup must never break a real claim.
    }
  }
}

// ── Extension install-id registration throttle ───────────────────────────────
// Each /register call mints ONE new server-signed device id. Capping registrations
// per fingerprint (falling back to IP) bounds how many fresh "devices" a single
// machine can conjure to sidestep the per-device claim cap — the whole point of
// issuing ids server-side. Generous enough for legitimate reinstalls / multiple real
// browsers, tight enough to stop scripted mass-minting. Fails OPEN on a Redis blip so
// a genuine new install is never left unable to register.
const EXT_REGISTER_MAX = 8
const EXT_REGISTER_WINDOW_SECONDS = 24 * 60 * 60

export async function extRegisterAllowed(ip: string, fingerprint?: string): Promise<boolean> {
  if (!redisEnabled) return true
  const subject = fingerprint || ip
  if (!subject) return true
  try {
    const key = `ext-register:${subject}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, EXT_REGISTER_WINDOW_SECONDS)
    return count <= EXT_REGISTER_MAX
  } catch {
    return true
  }
}

// Refunds ONE previously-charged slot on every identity (IP + device), flooring at
// 0 so it can never go negative. Used when a claim is charged but the handed-out
// account turns out to be UNUSABLE only once verified in the user's own browser
// (e.g. a Prime session that forces a password re-auth on the user's real IP — a
// state the server checker can't see from its datacenter IP). Refunding lets the
// extension immediately try another account without burning the user's daily limit.
export async function refundClaim(
  service: Service,
  ip: string,
  deviceId?: string,
  fingerprint?: string,
): Promise<void> {
  if (!redisEnabled) return
  for (const { kind, id } of claimIdentities(ip, deviceId, fingerprint)) {
    const key = claimWindowKey(service, kind, id)
    try {
      const current = Number((await redis.get<number>(key)) ?? 0) || 0
      if (current <= 0) continue
      // decr but never below 0; preserve the existing TTL (don't touch expire) so the
      // window still auto-clears on its original schedule.
      await redis.decr(key)
    } catch {
      // Best-effort — a failed refund is not worth breaking the retry flow over.
    }
  }
}

// ── Extension ↔ website reset bridge ────────────────────────────────────────
// The browser extension enforces the SAME per-service claim limits, but its second
// identity is the install id (extId) used as the "device" — a namespace the website
// admin reset can't see (it only knows the browser's signed device-id cookie). So on
// every extension claim we remember that extId under the claimant's IP; the admin
// "Reset my limits" can then also clear the extId device buckets seen from that IP,
// making the reset affect the extension too. The mapping self-expires so it never
// grows unbounded, and is scoped to the IP just like the rest of the reset.
const extIdsByIpKey = (ip: string): string => `claims:extids-by-ip:${ip}`
// Kept a bit longer than the longest claim window (24h) so a reset can still find and
// clear the extId bucket for a claim made near the end of that window.
const EXT_ID_MEMORY_SECONDS = 48 * 60 * 60

// ── Pending-reset bridge (IP → next extension install that checks in) ─────────
// The mapping above lets the admin reset clear extId buckets it ALREADY knows about,
// but that depends on the mapping having been populated (a best-effort Redis write
// that can be lost on a transient error). This second, more robust channel needs no
// pre-populated mapping: the admin reset drops a short-lived "reset pending" flag for
// its IP, and the NEXT time the extension calls /limits (which knows its OWN exact
// extId), it clears its own buckets and consumes the flag. Because the install
// resolves its own id live, this works even if the mapping write was never persisted.
const extResetPendingKey = (ip: string): string => `claims:ext-reset-pending:${ip}`
const EXT_RESET_PENDING_SECONDS = 15 * 60 // admin reopens the popup well within 15 min

// Admin reset: arm a pending reset for this IP. Best-effort; never blocks the reset.
export async function markExtResetPending(ip: string): Promise<void> {
  if (!redisEnabled || !ip) return
  try {
    await redis.set(extResetPendingKey(ip), "1", { ex: EXT_RESET_PENDING_SECONDS })
  } catch {
    // Best-effort — the mapping-based reset path still applies.
  }
}

// Extension /limits: if a reset is armed for this IP, clear THIS install's own claim
// buckets (IP + extId, every service) and consume the flag (single-use via GETDEL so
// it can't wipe ongoing claims repeatedly). Returns true if a reset was applied, so
// the caller recomputes the now-cleared allowance. No dependency on the extId mapping.
export async function runPendingExtReset(ip: string, extId: string, fingerprint?: string): Promise<boolean> {
  if (!redisEnabled || !ip || !extId) return false
  try {
    const pending = await redis.getdel(extResetPendingKey(ip))
    if (!pending) return false
    const services: Service[] = ["netflix", "prime", "crunchyroll"]
    const keys: string[] = []
    for (const service of services) {
      keys.push(claimWindowKey(service, "ip", ip))
      keys.push(claimWindowKey(service, "dev", extId))
      // The extension resolves its OWN fingerprint here, so this is the one place a
      // reset can also clear the install's fingerprint bucket (the website admin reset
      // never knows the extension's fingerprint).
      if (fingerprint) keys.push(claimWindowKey(service, "fp", fingerprint))
    }
    await redis.del(...keys)
    return true
  } catch {
    return false
  }
}

// Records that this extId claimed from this IP, so a later admin reset on the same IP
// can also clear the extId's device buckets. Best-effort; never blocks a claim.
export async function rememberClaimExtId(ip: string, extId: string): Promise<void> {
  if (!redisEnabled || !ip || !extId) return
  try {
    const key = extIdsByIpKey(ip)
    await redis.sadd(key, extId)
    await redis.expire(key, EXT_ID_MEMORY_SECONDS)
  } catch {
    // Best-effort — losing this mapping only means a reset won't reach the extension.
  }
}

// ADMIN TESTING AID — clears this identity's claim buckets for every service so the
// admin can immediately claim again on their own device without waiting out a window.
// Deletes the IP bucket, the browser device bucket, AND every extension install
// (extId) bucket that recently claimed from this IP — so the reset covers the website
// generator AND the extension. Best-effort and scoped to the passed IP/device only
// (never a global wipe). Returns how many keys were actually removed.
export async function resetClaimLimits(ip: string, deviceId?: string, fingerprint?: string): Promise<number> {
  if (!redisEnabled) return 0
  const services: Service[] = ["netflix", "prime", "crunchyroll"]
  const keys: string[] = []
  for (const service of services) {
    for (const { kind, id } of claimIdentities(ip, deviceId, fingerprint)) {
      keys.push(claimWindowKey(service, kind, id))
    }
  }
  // Also clear the extension install buckets last seen from this IP, plus the mapping
  // set itself. This is what makes the admin reset reach the extension.
  if (ip) {
    try {
      const extIds = (await redis.smembers(extIdsByIpKey(ip))) as string[]
      for (const extId of extIds) {
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(extId)) continue
        for (const service of services) keys.push(claimWindowKey(service, "dev", extId))
      }
      keys.push(extIdsByIpKey(ip))
    } catch {
      // Ignore — fall back to clearing just the website identity buckets.
    }
  }
  if (keys.length === 0) return 0
  try {
    return await redis.del(...keys)
  } catch (err) {
    console.log("[v0] resetClaimLimits: Redis error:", (err as Error)?.message)
    return 0
  }
}

// Consumes `cost` units (number of cookies in this request) from the IP's budget.
// When Redis isn't configured we allow everything so local/demo dev keeps working.
export async function consumeRateLimit(ip: string, cost: number): Promise<RateLimitResult> {
  if (!limiter) {
    return { success: true, limit: COOKIE_CHECKS_PER_MINUTE, remaining: COOKIE_CHECKS_PER_MINUTE, reset: Date.now() }
  }
  const safeCost = Math.max(1, Math.min(cost, COOKIE_CHECKS_PER_MINUTE))
  try {
    const { success, limit, remaining, reset } = await limiter.limit(ip, { rate: safeCost })
    return { success, limit, remaining, reset }
  } catch (err) {
    // Fail OPEN when Redis is unavailable/over-quota. This is the bug behind the
    // "server error" + checker timeouts: an UpstashError here was uncaught and 500'd
    // the entire /api/check request. The limiter is a cost guardrail, not a
    // correctness gate, so a Redis outage should degrade to "allow" — the checker
    // keeps working — rather than taking the whole feature down. Logged for visibility.
    console.log("[v0] consumeRateLimit: Redis error, failing open:", (err as Error)?.message)
    return { success: true, limit: COOKIE_CHECKS_PER_MINUTE, remaining: COOKIE_CHECKS_PER_MINUTE, reset: Date.now() }
  }
}
