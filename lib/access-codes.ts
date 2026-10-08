import { randomBytes } from "node:crypto"
import { sql } from "@/lib/db"
import { revokeLifetimePass } from "@/lib/access-pass"

export type AccessCodeRow = {
  id: number
  code: string
  durationHours: number
  accessType: "lifetime" | "temporary"
  active: boolean
  boundDeviceId: string | null
  boundIp: string | null
  boundAt: string | null
  netflixLimit: number
  primeLimit: number
  crunchyrollLimit: number
  netflixWindow: "hour" | "day"
  primeWindow: "hour" | "day"
  crunchyrollWindow: "hour" | "day"
  createdAt: string
  updatedAt: string
  redeemedAt: string | null
  expiresAt: string | null
}

let schemaReady: Promise<void> | null = null
async function ensureTable() {
  if (!sql) throw new Error("Database is not configured")
  schemaReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS access_codes (id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, duration_hours INTEGER NOT NULL DEFAULT 24, active BOOLEAN NOT NULL DEFAULT TRUE, bound_device_id TEXT, bound_ip TEXT, bound_at TIMESTAMPTZ, netflix_limit INTEGER NOT NULL DEFAULT 5, prime_limit INTEGER NOT NULL DEFAULT 5, crunchyroll_limit INTEGER NOT NULL DEFAULT 5, netflix_window TEXT NOT NULL DEFAULT 'day', prime_window TEXT NOT NULL DEFAULT 'day', crunchyroll_window TEXT NOT NULL DEFAULT 'day', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS access_type TEXT NOT NULL DEFAULT 'lifetime'`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`
    await sql`CREATE TABLE IF NOT EXISTS deleted_access_codes (code TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS netflix_limit INTEGER NOT NULL DEFAULT 5`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS prime_limit INTEGER NOT NULL DEFAULT 5`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS crunchyroll_limit INTEGER NOT NULL DEFAULT 5`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS netflix_window TEXT NOT NULL DEFAULT 'day'`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS prime_window TEXT NOT NULL DEFAULT 'day'`
    await sql`ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS crunchyroll_window TEXT NOT NULL DEFAULT 'day'`
    await sql`CREATE INDEX IF NOT EXISTS access_codes_active_idx ON access_codes (active)`
  })()
  return schemaReady
}

const normalize = (value: string) => value.trim().toUpperCase().replace(/\s+/g, "")

export async function redeemAccessCode(input: string, deviceId: string) {
  await ensureTable()
  const code = normalize(input)
  if (!/^(?:CML|CMF)-[A-Z0-9]{8}$/.test(code)) return { ok: false as const, error: "Enter a valid key, such as CML-ABCD1234 or CMF-ABCD1234." }
  // Lifetime keys are reusable as login credentials across devices, while
  // temporary keys remain bound to their first device and channel. The lifetime
  // key row remains the authority for limits and revocation.
  const channel = deviceId.startsWith("telegram:") ? "telegram" : "website"
  const rows = await sql!`UPDATE access_codes SET bound_device_id = CASE WHEN bound_device_id IS NULL THEN ${deviceId} ELSE bound_device_id END, bound_at = COALESCE(bound_at, NOW()), redeemed_at = COALESCE(redeemed_at, NOW()), expires_at = CASE WHEN access_type = 'temporary' THEN COALESCE(expires_at, NOW() + (${ACCESS_CODE_DURATION_HOURS} * INTERVAL '1 hour')) ELSE NULL END, updated_at = NOW() WHERE code = ${code} AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND (access_type = 'lifetime' OR (bound_device_id IS NULL OR bound_device_id = ${deviceId})) AND (access_type = 'lifetime' OR (${channel} = CASE WHEN bound_device_id LIKE 'telegram:%' THEN 'telegram' ELSE 'website' END OR bound_device_id IS NULL)) RETURNING id, duration_hours AS "durationHours", access_type AS "accessType", netflix_limit AS "netflixLimit", prime_limit AS "primeLimit", crunchyroll_limit AS "crunchyrollLimit", netflix_window AS "netflixWindow", prime_window AS "primeWindow", crunchyroll_window AS "crunchyrollWindow"`
  if (!rows[0]) return { ok: false as const, error: "This code is invalid, expired, revoked, or already linked to another device." }
  return { ok: true as const, codeId: Number(rows[0].id), accessType: rows[0].accessType === "temporary" ? "temporary" as const : "lifetime" as const, durationHours: Number(rows[0].durationHours) || ACCESS_CODE_DURATION_HOURS, limits: { netflix: Number(rows[0].netflixLimit) || 5, prime: Number(rows[0].primeLimit) || 5, crunchyroll: Number(rows[0].crunchyrollLimit) || 5 }, windows: { netflix: rows[0].netflixWindow === "hour" ? "hour" as const : "day" as const, prime: rows[0].primeWindow === "hour" ? "hour" as const : "day" as const, crunchyroll: rows[0].crunchyrollWindow === "hour" ? "hour" as const : "day" as const } }
}

export async function listAccessCodes() {
  await ensureTable()
  // Expired temporary keys must be reusable after activation. Clear their
  // binding and redemption metadata before rendering the admin list so the UI
  // reflects the same state enforced by pass validation.
  await sql!`UPDATE access_codes SET bound_device_id = NULL, bound_ip = NULL, bound_at = NULL, redeemed_at = NULL, expires_at = NULL, updated_at = NOW() WHERE access_type = 'temporary' AND active = TRUE AND expires_at IS NOT NULL AND expires_at <= NOW()`
  return sql!`SELECT id, code, duration_hours AS "durationHours", access_type AS "accessType", active, bound_device_id AS "boundDeviceId", bound_ip AS "boundIp", bound_at AS "boundAt", redeemed_at AS "redeemedAt", expires_at AS "expiresAt", CASE WHEN active = FALSE THEN 'Revoked' WHEN access_type = 'temporary' AND expires_at IS NOT NULL AND expires_at <= NOW() THEN 'Expired' WHEN bound_device_id IS NOT NULL OR redeemed_at IS NOT NULL THEN 'Redeemed' ELSE 'Unused' END AS status, CASE WHEN access_type = 'temporary' THEN NULL ELSE netflix_limit END AS "netflixLimit", CASE WHEN access_type = 'temporary' THEN NULL ELSE prime_limit END AS "primeLimit", CASE WHEN access_type = 'temporary' THEN NULL ELSE crunchyroll_limit END AS "crunchyrollLimit", CASE WHEN access_type = 'temporary' THEN NULL ELSE netflix_window END AS "netflixWindow", CASE WHEN access_type = 'temporary' THEN NULL ELSE prime_window END AS "primeWindow", CASE WHEN access_type = 'temporary' THEN NULL ELSE crunchyroll_window END AS "crunchyrollWindow", created_at AS "createdAt", updated_at AS "updatedAt" FROM access_codes ORDER BY id DESC`
}

const limitValue = (value: unknown) => Math.max(1, Math.min(100000, Math.floor(Number(value) || 1)))
const windowValue = (value: unknown): "hour" | "day" => value === "hour" ? "hour" : "day"
const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505"

export async function createAccessCode(input: string, limits?: Partial<Record<"netflix" | "prime" | "crunchyroll", unknown>>, windows?: Partial<Record<"netflix" | "prime" | "crunchyroll", unknown>>, accessType: "lifetime" | "temporary" = "lifetime") {
  await ensureTable()
  const prefix = accessType === "temporary" ? "CMF" : "CML"
  const requestedCode = normalize(input).replace(/^(?:CML|CMF)-/, "")
  if (requestedCode && !/^[A-Z0-9]{8}$/.test(requestedCode)) {
    throw new Error("Use exactly 8 letters or numbers after the prefix, for example ABCD1234.")
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rawCode = requestedCode || randomBytes(5).toString("hex").slice(0, 8).toUpperCase()
    const code = `${prefix}-${rawCode}`
    const deleted = await sql!`SELECT 1 FROM deleted_access_codes WHERE code = ${code}`
    if (deleted.length) {
      if (requestedCode) throw new Error("That access key was deleted and cannot be reused.")
      continue
    }
    try {
      const rows = await sql!`INSERT INTO access_codes (code, duration_hours, access_type, netflix_limit, prime_limit, crunchyroll_limit, netflix_window, prime_window, crunchyroll_window) VALUES (${code}, ${accessType === "temporary" ? ACCESS_CODE_DURATION_HOURS : 0}, ${accessType === "temporary" ? "temporary" : "lifetime"}, ${accessType === "temporary" ? 0 : limitValue(limits?.netflix)}, ${accessType === "temporary" ? 0 : limitValue(limits?.prime)}, ${accessType === "temporary" ? 0 : limitValue(limits?.crunchyroll)}, ${accessType === "temporary" ? "day" : windowValue(windows?.netflix)}, ${accessType === "temporary" ? "day" : windowValue(windows?.prime)}, ${accessType === "temporary" ? "day" : windowValue(windows?.crunchyroll)}) RETURNING id, code`
      return rows[0]
    } catch (error) {
      if (requestedCode || !isUniqueViolation(error)) throw error
    }
  }
  throw new Error("Unable to generate a unique access key. Please try again.")
}

export async function updateAccessCode(id: number, action: "revoke" | "activate" | "unbind" | "delete" | "limits", limits?: Partial<Record<"netflix" | "prime" | "crunchyroll", unknown>>, windows?: Partial<Record<"netflix" | "prime" | "crunchyroll", unknown>>) {
  await ensureTable()
  if (action === "delete") {
    const rows = await sql!`SELECT bound_device_id AS "boundDeviceId" FROM access_codes WHERE id = ${id}`
    const boundDeviceId = rows[0]?.boundDeviceId as string | null | undefined
    if (boundDeviceId && !(await revokeLifetimePass(boundDeviceId))) {
      throw new Error("Unable to revoke the device access. The code was not deleted.")
    }
    const codeRows = await sql!`SELECT code FROM access_codes WHERE id = ${id}`
    const deletedCode = codeRows[0]?.code as string | undefined
    if (deletedCode) await sql!`INSERT INTO deleted_access_codes (code) VALUES (${deletedCode}) ON CONFLICT (code) DO NOTHING`
    return sql!`DELETE FROM access_codes WHERE id = ${id}`
  }
  if (action === "unbind") {
    const rows = await sql!`SELECT bound_device_id AS "boundDeviceId" FROM access_codes WHERE id = ${id}`
    const boundDeviceId = rows[0]?.boundDeviceId as string | null | undefined
    if (boundDeviceId) {
      const revoked = await revokeLifetimePass(boundDeviceId)
      if (!revoked) throw new Error("Unable to revoke the bound device access. The code was not unbound.")
    }
    return sql!`UPDATE access_codes SET bound_device_id = NULL, bound_ip = NULL, bound_at = NULL, redeemed_at = NULL, expires_at = NULL, updated_at = NOW() WHERE id = ${id}`
  }
  if (action === "limits") return sql!`UPDATE access_codes SET netflix_limit = ${limitValue(limits?.netflix)}, prime_limit = ${limitValue(limits?.prime)}, crunchyroll_limit = ${limitValue(limits?.crunchyroll)}, netflix_window = ${windowValue(windows?.netflix)}, prime_window = ${windowValue(windows?.prime)}, crunchyroll_window = ${windowValue(windows?.crunchyroll)}, updated_at = NOW() WHERE id = ${id}`
  if (action === "revoke") {
    const rows = await sql!`SELECT bound_device_id AS "boundDeviceId" FROM access_codes WHERE id = ${id}`
    const boundDeviceId = rows[0]?.boundDeviceId as string | null | undefined
    if (boundDeviceId && !(await revokeLifetimePass(boundDeviceId))) {
      throw new Error("Unable to revoke the bound device access. The code was not reset.")
    }
    // Revocation is a full reset: the next activation can be redeemed by a new device.
    return sql!`UPDATE access_codes SET active = FALSE, bound_device_id = NULL, bound_ip = NULL, bound_at = NULL, redeemed_at = NULL, expires_at = NULL, updated_at = NOW() WHERE id = ${id}`
  }
  return sql!`UPDATE access_codes SET active = TRUE, expires_at = NULL, updated_at = NOW() WHERE id = ${id}`
}

export { normalize as normalizeAccessCode }

export async function ensureAccessCodesSchema() { await ensureTable() }

export type AccessCodeResult = Awaited<ReturnType<typeof listAccessCodes>>[number]

export function maskBinding(value: string | null) { return value ? `${value.slice(0, 6)}…` : "Unbound" }

export function accessCodeLabel(row: AccessCodeResult) { return `${row.code} · ${row.active ? "Active" : "Revoked"}` }

export async function deleteAccessCode(id: number) {
  await updateAccessCode(id, "delete")
}

export async function resetRedemptionForDevice(deviceId: string): Promise<number> {
  await ensureTable()
  const result = await sql!`UPDATE access_codes SET bound_device_id = NULL, bound_ip = NULL, bound_at = NULL, redeemed_at = NULL, expires_at = NULL, updated_at = NOW() WHERE bound_device_id = ${deviceId} RETURNING id`
  return result.length
}

export async function getAccessCodeByValue(input: string) {
  await ensureTable()
  const code = normalize(input)
  const rows = await sql!`SELECT id, access_type AS "accessType", active, expires_at AS "expiresAt" FROM access_codes WHERE code = ${code}`
  return rows[0] ?? null
}

export async function getAccessCodeByDeviceId(deviceId: string) {
  await ensureTable()
  const rows = await sql!`SELECT id FROM access_codes WHERE bound_device_id = ${deviceId} AND active = TRUE AND access_type IN ('lifetime', 'temporary') AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`
  return rows[0] ? getAccessCode(Number(rows[0].id)) : null
}

export async function getAccessCode(id: number) {
  await ensureTable()
  const rows = await sql!`
    SELECT
      id,
      code,
      duration_hours AS "durationHours",
      access_type AS "accessType",
      active,
      bound_device_id AS "boundDeviceId",
      bound_ip AS "boundIp",
      bound_at AS "boundAt",
      redeemed_at AS "redeemedAt",
      expires_at AS "expiresAt",
      netflix_limit AS "netflixLimit",
      prime_limit AS "primeLimit",
      crunchyroll_limit AS "crunchyrollLimit",
      netflix_window AS "netflixWindow",
      prime_window AS "primeWindow",
      crunchyroll_window AS "crunchyrollWindow"
    FROM access_codes
    WHERE id = ${id}
  `
  return rows[0] ?? null
}

export async function getAccessCodeLimits(id: number, service: "netflix" | "prime" | "crunchyroll") {
  await ensureTable()
  const rows = await sql!`SELECT access_type AS "accessType", netflix_limit AS "netflixLimit", prime_limit AS "primeLimit", crunchyroll_limit AS "crunchyrollLimit", netflix_window AS "netflixWindow", prime_window AS "primeWindow", crunchyroll_window AS "crunchyrollWindow" FROM access_codes WHERE id = ${id} AND active = TRUE`
  const row = rows[0]
  if (!row || row.accessType === "temporary") return null
  const limit = Number(row[`${service}Limit`]) || 1
  const window = row[`${service}Window`] === "hour" ? "hour" : "day"
  return { limit, windowSeconds: window === "hour" ? 3600 : 86400, label: `${limit} per ${window}` }
}

export function accessCodeStorageAvailable() { return Boolean(sql) }

export const ACCESS_CODE_DURATION_HOURS = 24
