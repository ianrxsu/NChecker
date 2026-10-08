import { redis, redisEnabled } from "./redis"
import { sql } from "./db"
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

// 24 hours. The window is anchored to the FIRST genuine gateway completion (see
// grantPass — repeat claims inside the window never extend it).
export const PASS_TTL_SECONDS = 24 * 60 * 60

// ── Mode toggle (admin) ──────────────────────────────────────────────────────
const MODE_KEY = "site:access-pass-mode"
const MODE_CACHE_KEY = "access-pass-mode"
const MODE_CACHE_TTL_MS = 30_000

// Fails to false (per-claim gating) whenever Redis is down/unset.
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

export async function setAccessPassMode(next: boolean): Promise<boolean> {
  if (!redisEnabled) {
    throw new Error("Storage is not configured, so Access Pass mode can't be saved.")
  }
  await redis.set(MODE_KEY, next)
  bustConfigCache(MODE_CACHE_KEY)
  return next
}

// ── Per-device pass (stored in Neon Postgres) ────────────────────────────────
// One row per signed, HTTP-only device id (the primary key makes every unlock
// unique to a device). A pass is DEVICE-ONLY — never IP-based — so completing the
// gateway on one device can never unlock anyone else. Clearing cookies drops the
// device id and therefore the pass. Expiry is enforced by comparing expires_at to
// the database clock on every read, so a pass locks again exactly at 24h.
//
// kind: 'timed'     → earned by a gateway completion, expires_at = +24h
//       'temporary' → earned by a CMF key, expires_at = +24h, re-checked against the key
//       'lifetime'  → earned by a CML key, expires_at NULL, re-checked against the key
let schemaReady: Promise<void> | null = null
async function ensureTable() {
  if (!sql) throw new Error("Database is not configured")
  schemaReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS device_passes (device_id TEXT PRIMARY KEY, kind TEXT NOT NULL, code_id BIGINT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    await sql`CREATE INDEX IF NOT EXISTS device_passes_expires_idx ON device_passes (expires_at)`
  })().catch((error) => {
    schemaReady = null
    throw error
  })
  return schemaReady
}

export type PassState = { valid: boolean; expiresAt: number | null; accessCodeId?: number }

const LOCKED: PassState = { valid: false, expiresAt: null }

async function clearNotifyKeys(deviceId: string) {
  if (!redisEnabled) return
  try {
    await redis.del(`pass-expiry:${deviceId}`, `pass-reset-notified:${deviceId}`)
  } catch {
    // best effort — Telegram reset notices only
  }
}

// Grants the 24h pass for this device. Only creates a new window when none is
// active (a missing or already-expired row), so repeat claims inside the 24h can
// NEVER extend it. Returns the effective expiry in ms, or null on empty id / error.
export async function grantPass(deviceId: string, codeId?: number): Promise<number | null> {
  if (!sql || !deviceId) return null
  try {
    await ensureTable()
    const kind = codeId ? "temporary" : "timed"
    const created = await sql`
      INSERT INTO device_passes (device_id, kind, code_id, expires_at)
      VALUES (${deviceId}, ${kind}, ${codeId ?? null}, NOW() + (${PASS_TTL_SECONDS} * INTERVAL '1 second'))
      ON CONFLICT (device_id) DO UPDATE
        SET kind = EXCLUDED.kind, code_id = EXCLUDED.code_id, expires_at = EXCLUDED.expires_at, created_at = NOW()
        WHERE device_passes.expires_at IS NOT NULL AND device_passes.expires_at <= NOW()
      RETURNING (EXTRACT(EPOCH FROM expires_at) * 1000)::BIGINT AS "expiresAt"`
    if (created[0]) {
      const expiresAt = Number(created[0].expiresAt)
      if (redisEnabled) {
        try {
          await redis.set(`pass-expiry:${deviceId}`, expiresAt, { ex: PASS_TTL_SECONDS + 86400 })
        } catch {
          // best effort
        }
      }
      return expiresAt
    }
    const existing = await sql`SELECT (EXTRACT(EPOCH FROM expires_at) * 1000)::BIGINT AS "expiresAt" FROM device_passes WHERE device_id = ${deviceId} AND expires_at > NOW()`
    return existing[0] ? Number(existing[0].expiresAt) : null
  } catch (error) {
    console.error("[access-pass] grantPass failed", error)
    return null
  }
}

// Grants permanent access for a redeemed lifetime key, bound to this device id.
export async function grantLifetimePass(deviceId: string, codeId?: number): Promise<boolean> {
  // Lifetime access must carry a database key id so revocation can be verified.
  if (!sql || !deviceId || !codeId) return false
  try {
    await ensureTable()
    await sql`
      INSERT INTO device_passes (device_id, kind, code_id, expires_at)
      VALUES (${deviceId}, 'lifetime', ${codeId}, NULL)
      ON CONFLICT (device_id) DO UPDATE
        SET kind = 'lifetime', code_id = EXCLUDED.code_id, expires_at = NULL, created_at = NOW()`
    return true
  } catch (error) {
    console.error("[access-pass] grantLifetimePass failed", error)
    return false
  }
}

export async function revokeLifetimePass(deviceId: string): Promise<boolean> {
  if (!sql || !deviceId) return false
  try {
    await ensureTable()
    await sql`DELETE FROM device_passes WHERE device_id = ${deviceId}`
    await clearNotifyKeys(deviceId)
    return true
  } catch {
    return false
  }
}

// Reads this device's pass. Fails to locked on any error or missing device id.
export async function getPass(deviceId: string): Promise<PassState> {
  if (!sql || !deviceId) return LOCKED
  try {
    await ensureTable()
    const rows = await sql`SELECT kind, code_id AS "codeId", (EXTRACT(EPOCH FROM expires_at) * 1000)::BIGINT AS "expiresAt", (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired FROM device_passes WHERE device_id = ${deviceId}`
    const row = rows[0]
    if (!row) return LOCKED

    if (row.expired) {
      await sql`DELETE FROM device_passes WHERE device_id = ${deviceId} AND expires_at <= NOW()`
      await clearNotifyKeys(deviceId)
      return LOCKED
    }

    const accessCodeId = Number(row.codeId) || undefined
    const expiresAt = row.expiresAt === null ? null : Number(row.expiresAt)

    if (row.kind === "timed") {
      return expiresAt ? { valid: true, expiresAt } : LOCKED
    }

    // Key-based passes are re-checked against the authoritative access_codes row
    // so admin revocation/unbinding takes effect immediately.
    if (!accessCodeId) {
      await revokeLifetimePass(deviceId)
      return LOCKED
    }
    const { getAccessCode } = await import("@/lib/access-codes")
    const code = await getAccessCode(accessCodeId)
    const type = row.kind === "lifetime" ? "lifetime" : "temporary"
    const codeExpired = type === "temporary" && (!code?.expiresAt || new Date(code.expiresAt).getTime() <= Date.now())
    if (!code || !code.active || code.accessType !== type || code.boundDeviceId !== deviceId || codeExpired) {
      await revokeLifetimePass(deviceId)
      return LOCKED
    }
    return { valid: true, expiresAt: type === "lifetime" ? null : expiresAt, accessCodeId }
  } catch (error) {
    console.error("[access-pass] getPass failed", error)
    return LOCKED
  }
}

// ── Per-IP pass-mint cap (defense in depth) ──────────────────────────────────
// Generous ceiling on distinct device passes minted per IP per rolling 24h. Fails
// OPEN (allowed) on any Redis error or when Redis isn't configured.
const PASS_MINTS_PER_IP_PER_DAY = 20

function passMintKey(ip: string): string {
  return `pass-mint:${ip}`
}

export async function passMintAllowed(ip: string): Promise<boolean> {
  if (!redisEnabled || !ip) return true
  try {
    const used = Number((await redis.get<number>(passMintKey(ip))) ?? 0) || 0
    return used < PASS_MINTS_PER_IP_PER_DAY
  } catch {
    return true
  }
}

export async function recordPassMint(ip: string): Promise<void> {
  if (!redisEnabled || !ip) return
  try {
    const count = await redis.incr(passMintKey(ip))
    if (count === 1) await redis.expire(passMintKey(ip), PASS_TTL_SECONDS)
  } catch {
    // Best-effort — a limiter hiccup must never wedge a genuine unlock.
  }
}
