import { createHash } from "node:crypto"
import { sql, dbEnabled } from "@/lib/db"
import type { CheckResult } from "@/lib/normalize-upstream"
import { normalizePlan } from "@/lib/cookie-utils"
import { encryptCookie, decryptCookie } from "@/lib/cookie-crypto"

// Steam variant of lib/saved-cookies.ts. Identical logic, but targets the
// dedicated `saved_steam_cookies` table so each service's account pool stays
// fully separate. Steam accounts have no email identity in many cases, so the
// per-account fingerprint falls back to the cookie hash.

export type SavedCookie = {
  id: string
  cookie: string
  email: string | null
  plan: string | null
  countryCode: string | null
  paymentMethod: string | null
  nextBillingCycle: string | null
  memberSince: string | null
  phone: string | null
  maxStreams: number | null
  emailVerified: boolean | null
  profiles: string[] | null
  links: { pc?: string; mobile?: string; tv?: string } | null
  createdAt: string
  updatedAt: string
}

export type AliveEntry = {
  cookie: string
  result: CheckResult
}

// Steam rarely exposes an email, so the fingerprint prefers the account name
// (profiles[0]) when present, then falls back to hashing the cookie.
function accountFingerprint(email: string | null | undefined, name: string | null | undefined, cookie: string): string {
  const normalizedEmail = email?.trim().toLowerCase()
  const normalizedName = name?.trim().toLowerCase()
  const basis = normalizedEmail
    ? `email:${normalizedEmail}`
    : normalizedName
      ? `name:${normalizedName}`
      : `cookie:${cookie.trim()}`
  return createHash("sha256").update(basis).digest("hex")
}

function mapRow(row: Record<string, unknown>): SavedCookie {
  return {
    id: String(row.id),
    cookie: decryptCookie(String(row.cookie ?? "")),
    email: (row.email as string) ?? null,
    plan: (row.plan as string) ?? null,
    countryCode: (row.country_code as string) ?? null,
    paymentMethod: (row.payment_method as string) ?? null,
    nextBillingCycle: (row.next_billing_cycle as string) ?? null,
    memberSince: (row.member_since as string) ?? null,
    phone: (row.phone as string) ?? null,
    maxStreams: row.max_streams == null ? null : Number(row.max_streams),
    emailVerified: row.email_verified == null ? null : Boolean(row.email_verified),
    profiles: Array.isArray(row.profiles) ? (row.profiles as string[]) : null,
    links: (row.links as SavedCookie["links"]) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }
}

export async function saveAliveSteamCookies(entries: AliveEntry[]): Promise<{ saved: number }> {
  if (!sql || entries.length === 0) return { saved: 0 }

  const byPrint = new Map<string, AliveEntry>()
  for (const e of entries) {
    const cookie = e.cookie?.trim()
    if (!cookie) continue
    byPrint.set(accountFingerprint(e.result?.email, e.result?.profiles?.[0], cookie), e)
  }

  let saved = 0
  for (const [fp, { cookie, result }] of byPrint) {
    const email = result.email?.trim().toLowerCase()
    const storedCookie = encryptCookie(cookie)
    if (email) {
      await sql`
        DELETE FROM saved_steam_cookies
        WHERE lower(email) = ${email} AND fingerprint <> ${fp}
      `
    }

    const rows = (await sql`
      INSERT INTO saved_steam_cookies (
        fingerprint, cookie, email, plan, country_code, payment_method,
        next_billing_cycle, member_since, phone, max_streams, email_verified,
        profiles, links, raw, updated_at
      ) VALUES (
        ${fp}, ${storedCookie}, ${result.email ?? null}, ${normalizePlan(result.plan) ?? null},
        ${result.countryCode ?? null}, ${result.paymentMethod ?? null},
        ${result.nextBillingCycle ?? null}, ${result.memberSince ?? null},
        ${result.phone ?? null}, ${result.maxStreams ?? null}, ${result.emailVerified ?? null},
        ${JSON.stringify(result.profiles ?? null)}, ${JSON.stringify(result.links ?? null)},
        ${JSON.stringify(result.raw ?? null)}, now()
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        cookie = EXCLUDED.cookie,
        email = EXCLUDED.email,
        plan = EXCLUDED.plan,
        country_code = EXCLUDED.country_code,
        payment_method = EXCLUDED.payment_method,
        next_billing_cycle = EXCLUDED.next_billing_cycle,
        member_since = EXCLUDED.member_since,
        phone = EXCLUDED.phone,
        max_streams = EXCLUDED.max_streams,
        email_verified = EXCLUDED.email_verified,
        profiles = EXCLUDED.profiles,
        links = EXCLUDED.links,
        raw = EXCLUDED.raw,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    `) as { inserted: boolean }[]
    if (rows[0]?.inserted) saved++
  }

  return { saved }
}

export async function listSavedSteamCookies(limit?: number): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (
    limit && Number.isFinite(limit)
      ? await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_steam_cookies
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_steam_cookies
          ORDER BY created_at DESC
        `
  ) as Record<string, unknown>[]
  return rows.map(mapRow)
}

// Admin listing WITHOUT the cookie blob — see saved-cookies.ts for the rationale.
// Cuts the admin dashboard read by ~95%; cookies fetched on demand via loadByIds.
export async function listSavedSteamCookieDetails(): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (await sql`
    SELECT id, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_steam_cookies
    ORDER BY created_at DESC
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export async function countSavedSteamCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`SELECT COUNT(*)::int AS count FROM saved_steam_cookies`) as { count: number }[]
  return rows[0]?.count ?? 0
}

export async function listAllSavedSteamCookieIds(): Promise<string[]> {
  if (!sql) return []
  const rows = (await sql`SELECT id FROM saved_steam_cookies ORDER BY id ASC`) as { id: number }[]
  return rows.map((r) => String(r.id))
}

export async function loadSavedSteamCookiesByIds(ids: string[]): Promise<SavedCookie[]> {
  if (!sql || ids.length === 0) return []
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return []
  const rows = (await sql`
    SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_steam_cookies
    WHERE id = ANY(${numeric})
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export async function deleteSavedSteamCookie(id: string): Promise<boolean> {
  if (!sql) return false
  const numericId = Number(id)
  if (!Number.isInteger(numericId)) return false
  const rows = (await sql`DELETE FROM saved_steam_cookies WHERE id = ${numericId} RETURNING id`) as { id: number }[]
  return rows.length > 0
}

export async function removeSavedSteamCookies(ids: string[]): Promise<number> {
  if (!sql || ids.length === 0) return 0
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return 0
  const rows = (await sql`DELETE FROM saved_steam_cookies WHERE id = ANY(${numeric}) RETURNING id`) as { id: number }[]
  return rows.length
}

export async function clearSavedSteamCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`DELETE FROM saved_steam_cookies RETURNING id`) as { id: number }[]
  return rows.length
}

export { dbEnabled }
