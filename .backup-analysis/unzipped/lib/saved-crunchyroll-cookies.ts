import { createHash } from "node:crypto"
import { sql, dbEnabled } from "@/lib/db"
import type { CheckResult } from "@/lib/normalize-upstream"
import { normalizePlan, planMatchLikePatterns } from "@/lib/cookie-utils"
import { encryptCookie, decryptCookie } from "@/lib/cookie-crypto"

// Crunchyroll variant of lib/saved-cookies.ts. Identical logic, but targets the
// dedicated `saved_crunchyroll_cookies` table so the Netflix, Prime, and
// Crunchyroll account pools stay fully separate. Keeping this as a copy (rather
// than parametrizing the Netflix lib) avoids touching the battle-tested queries.

// A persisted alive Crunchyroll cookie plus the parsed account details.
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

// One alive entry to persist (cleaned cookie string + its parsed result).
export type AliveEntry = {
  cookie: string
  result: CheckResult
}

// Stable per-ACCOUNT key so the same account is never stored twice. Keyed on the
// normalized email when present (true identity); falls back to hashing the
// cookie. The unique index on `fingerprint` + ON CONFLICT upsert dedups.
function accountFingerprint(email: string | null | undefined, cookie: string): string {
  const normalizedEmail = email?.trim().toLowerCase()
  const basis = normalizedEmail ? `email:${normalizedEmail}` : `cookie:${cookie.trim()}`
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

// Upserts a batch of alive Crunchyroll cookies. Returns how many rows were
// inserted as new (existing fingerprints are refreshed in place, not counted).
export async function saveAliveCrunchyrollCookies(entries: AliveEntry[]): Promise<{ saved: number }> {
  if (!sql || entries.length === 0) return { saved: 0 }

  const byPrint = new Map<string, AliveEntry>()
  for (const e of entries) {
    const cookie = e.cookie?.trim()
    if (!cookie) continue
    byPrint.set(accountFingerprint(e.result?.email, cookie), e)
  }

  let saved = 0
  for (const [fp, { cookie, result }] of byPrint) {
    const email = result.email?.trim().toLowerCase()
    const storedCookie = encryptCookie(cookie)
    if (email) {
      await sql`
        DELETE FROM saved_crunchyroll_cookies
        WHERE lower(email) = ${email} AND fingerprint <> ${fp}
      `
    }

    const rows = (await sql`
      INSERT INTO saved_crunchyroll_cookies (
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

export async function listSavedCrunchyrollCookies(limit?: number): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (
    limit && Number.isFinite(limit)
      ? await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_crunchyroll_cookies
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_crunchyroll_cookies
          ORDER BY created_at DESC
        `
  ) as Record<string, unknown>[]
  return rows.map(mapRow)
}

// Admin listing WITHOUT the cookie blob — see saved-cookies.ts for the rationale.
// Cuts the admin dashboard read by ~95%; cookies fetched on demand via loadByIds.
export async function listSavedCrunchyrollCookieDetails(): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (await sql`
    SELECT id, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_crunchyroll_cookies
    ORDER BY created_at DESC
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export async function countSavedCrunchyrollCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`SELECT COUNT(*)::int AS count FROM saved_crunchyroll_cookies`) as { count: number }[]
  return rows[0]?.count ?? 0
}

// Lightweight per (plan, country) availability aggregate — see saved-cookies.ts for
// the full rationale. Transfers a handful of rows instead of the whole table's blobs.
export type PoolSummaryRow = { plan: string | null; country: string | null; count: number }
export async function summarizeSavedCrunchyrollCookies(): Promise<PoolSummaryRow[]> {
  if (!sql) return []
  return (await sql`
    SELECT plan, country_code AS country, COUNT(*)::int AS count
    FROM saved_crunchyroll_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
    GROUP BY plan, country_code
  `) as PoolSummaryRow[]
}

// Lightweight id/plan/country metadata (no cookie blob) for the distribution engine.
export type SavedCookieMeta = { id: string; plan: string | null; countryCode: string | null }
export async function listSavedCrunchyrollCookieMeta(): Promise<SavedCookieMeta[]> {
  if (!sql) return []
  const rows = (await sql`
    SELECT id, plan, country_code
    FROM saved_crunchyroll_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
    ORDER BY created_at DESC
  `) as { id: number; plan: string | null; country_code: string | null }[]
  return rows.map((r) => ({ id: String(r.id), plan: r.plan, countryCode: r.country_code }))
}

// Bounded per-claim candidate sample — see saved-cookies.ts for the full rationale.
// Keeps claim egress constant regardless of pool size.
export async function sampleSavedCrunchyrollCookieCandidates(opts: {
  plan: string | null
  country: string | null
  receivedIds: string[]
  limit?: number
}): Promise<SavedCookieMeta[]> {
  if (!sql) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 150, 500))
  const received = (opts.receivedIds ?? []).map(Number).filter(Number.isInteger)
  const receivedArr = received.length ? received : [-1]
  const country = opts.country || null
  const patterns = planMatchLikePatterns(opts.plan)
  const patternsArr = patterns ?? ["%"]
  const noPlan = patterns === null

  type Row = { id: number; plan: string | null; country_code: string | null }
  const preferred = (await sql`
    SELECT id, plan, country_code
    FROM saved_crunchyroll_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
      AND NOT (id = ANY(${receivedArr}))
      AND (${country}::text IS NULL OR country_code = ${country})
      AND (${noPlan} OR plan ILIKE ANY(${patternsArr}))
    ORDER BY random()
    LIMIT ${limit}
  `) as Row[]
  const fallback = (await sql`
    SELECT id, plan, country_code
    FROM saved_crunchyroll_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
      AND NOT (id = ANY(${receivedArr}))
    ORDER BY random()
    LIMIT ${limit}
  `) as Row[]

  const seen = new Set<string>()
  const out: SavedCookieMeta[] = []
  for (const r of [...preferred, ...fallback]) {
    const id = String(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, plan: r.plan, countryCode: r.country_code })
  }
  return out
}

export async function listAllSavedCrunchyrollCookieIds(): Promise<string[]> {
  if (!sql) return []
  const rows = (await sql`SELECT id FROM saved_crunchyroll_cookies ORDER BY id ASC`) as { id: number }[]
  return rows.map((r) => String(r.id))
}

export async function loadSavedCrunchyrollCookiesByIds(ids: string[]): Promise<SavedCookie[]> {
  if (!sql || ids.length === 0) return []
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return []
  const rows = (await sql`
    SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_crunchyroll_cookies
    WHERE id = ANY(${numeric})
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export async function deleteSavedCrunchyrollCookie(id: string): Promise<boolean> {
  if (!sql) return false
  const numericId = Number(id)
  if (!Number.isInteger(numericId)) return false
  const rows = (await sql`DELETE FROM saved_crunchyroll_cookies WHERE id = ${numericId} RETURNING id`) as {
    id: number
  }[]
  return rows.length > 0
}

export async function removeSavedCrunchyrollCookies(ids: string[]): Promise<number> {
  if (!sql || ids.length === 0) return 0
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return 0
  const rows = (await sql`DELETE FROM saved_crunchyroll_cookies WHERE id = ANY(${numeric}) RETURNING id`) as {
    id: number
  }[]
  return rows.length
}

export async function clearSavedCrunchyrollCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`DELETE FROM saved_crunchyroll_cookies RETURNING id`) as { id: number }[]
  return rows.length
}

export { dbEnabled }
