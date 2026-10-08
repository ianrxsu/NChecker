import { neon } from "@neondatabase/serverless"

// ── DURABLE CLAIM ANALYTICS (Neon Postgres) ─────────────────────────────────
// High-frequency counters (checks, users, live totals) stay on Redis — they're
// hot, ephemeral, and TTL-managed. This module handles the DURABLE, low-frequency
// record we want to keep and query long-term: one row per SUCCESSFUL reward claim.
// Claims happen orders of magnitude less often than checks, so a per-claim SQL
// INSERT is cheap and never touches the checker hot path. No IPs or user data are
// stored — only service, plan, country, and which pooled account was handed out.

// Lazily create the SQL client so importing this module never throws when
// DATABASE_URL is absent (local/demo). All callers below no-op without it.
let _sql: ReturnType<typeof neon> | null = null
function sql() {
  if (_sql) return _sql
  const url = process.env.DATABASE_URL
  if (!url) return null
  _sql = neon(url)
  return _sql
}

export type ClaimEventInput = {
  service: string
  plan?: string | null
  country?: string | null
  accountId?: string | null
}

// Fire-and-forget insert. Wrapped so a DB hiccup can NEVER break a claim — this is
// analytics, not the source of truth. Call it via `waitUntil(...)` so the write
// survives past the serverless response.
export async function recordClaimEvent(evt: ClaimEventInput): Promise<void> {
  const db = sql()
  if (!db) return
  try {
    await db`
      INSERT INTO claim_events (service, plan, country, account_id)
      VALUES (${evt.service}, ${evt.plan ?? null}, ${evt.country ?? null}, ${evt.accountId ?? null})
    `
    // A new claim landed → drop the cached analytics so the next dashboard poll
    // reflects it immediately instead of serving up to CLAIMS_TTL_MS-stale numbers.
    claimsCache = null
  } catch (err) {
    console.log("[v0] recordClaimEvent failed (non-fatal):", (err as Error)?.message)
  }
}

export type ClaimAnalytics = {
  enabled: boolean
  total: number
  last24h: number
  last7d: number
  byService: Record<string, number>
  perDay: { day: string; count: number }[]
  topCountries: { country: string; count: number }[]
  topPlans: { plan: string; count: number }[]
  recent: { service: string; plan: string | null; country: string | null; createdAt: string }[]
}

export const emptyClaimAnalytics: ClaimAnalytics = {
  enabled: false,
  total: 0,
  last24h: 0,
  last7d: 0,
  byService: {},
  perDay: [],
  topCountries: [],
  topPlans: [],
  recent: [],
}

// Short-lived in-process cache for the claim analytics, matching getMetrics().
// The admin dashboard polls this alongside metrics; without a cache each poll
// fired SIX Neon queries per open tab forever (traffic-independent), which was a
// top driver of Neon compute time. A 60s TTL collapses all polls (across every
// viewer, module-level on a warm lambda) into at most one 6-query batch per
// minute, and it's busted instantly whenever a new claim is recorded. Claims are
// low-frequency analytics, so a minute of staleness is imperceptible.
const CLAIMS_TTL_MS = 60_000
let claimsCache: { at: number; data: ClaimAnalytics } | null = null
let claimsInflight: Promise<ClaimAnalytics> | null = null

// Reads the durable claim history for the admin dashboard. Returns a disabled
// empty shape (never throws) when the DB is unavailable, so the panel still
// renders and the Redis-backed sections are unaffected.
export async function getClaimAnalytics(): Promise<ClaimAnalytics> {
  const db = sql()
  if (!db) return emptyClaimAnalytics

  const now = Date.now()
  if (claimsCache && now - claimsCache.at < CLAIMS_TTL_MS) return claimsCache.data
  // Collapse concurrent callers (multiple polls/tabs on a cold cache) onto ONE
  // in-flight query batch instead of each firing its own six queries.
  if (claimsInflight) return claimsInflight

  claimsInflight = (async () => {
    try {
      const data = await readClaimAnalytics(db)
      claimsCache = { at: Date.now(), data }
      return data
    } catch (err) {
      console.log("[v0] getClaimAnalytics failed, returning empty:", (err as Error)?.message)
      // Cache the empty result briefly so a struggling DB isn't re-hit every poll.
      claimsCache = { at: Date.now(), data: emptyClaimAnalytics }
      return emptyClaimAnalytics
    } finally {
      claimsInflight = null
    }
  })()
  return claimsInflight
}

async function readClaimAnalytics(db: NonNullable<ReturnType<typeof sql>>): Promise<ClaimAnalytics> {
  {
    const [totals, byService, perDay, topCountries, topPlans, recent] = await Promise.all([
      db`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last24h,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS last7d
        FROM claim_events
      `,
      db`SELECT service, COUNT(*)::int AS count FROM claim_events GROUP BY service ORDER BY count DESC`,
      db`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM claim_events
        WHERE created_at >= now() - interval '14 days'
        GROUP BY day ORDER BY day ASC
      `,
      db`
        SELECT COALESCE(country, 'Unknown') AS country, COUNT(*)::int AS count
        FROM claim_events GROUP BY country ORDER BY count DESC LIMIT 8
      `,
      db`
        SELECT COALESCE(plan, 'Unknown') AS plan, COUNT(*)::int AS count
        FROM claim_events GROUP BY plan ORDER BY count DESC LIMIT 8
      `,
      db`
        SELECT service, plan, country, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM claim_events ORDER BY created_at DESC LIMIT 20
      `,
    ])

    const t = (totals as { total: number; last24h: number; last7d: number }[])[0] ?? {
      total: 0,
      last24h: 0,
      last7d: 0,
    }
    return {
      enabled: true,
      total: t.total ?? 0,
      last24h: t.last24h ?? 0,
      last7d: t.last7d ?? 0,
      byService: Object.fromEntries((byService as { service: string; count: number }[]).map((r) => [r.service, r.count])),
      perDay: perDay as { day: string; count: number }[],
      topCountries: topCountries as { country: string; count: number }[],
      topPlans: topPlans as { plan: string; count: number }[],
      recent: (recent as { service: string; plan: string | null; country: string | null; created_at: string }[]).map(
        (r) => ({ service: r.service, plan: r.plan, country: r.country, createdAt: r.created_at }),
      ),
    }
  }
}
