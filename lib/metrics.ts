import { createHash } from "node:crypto"
import { sql, dbEnabled } from "./db"
import type { CheckErrorCategory } from "./check-errors"

// Durable observability layer in Neon Postgres (our analytics database). The admin
// panel reads these. All writes are fire-and-forget so they never slow a check.
//
// This used to live in Redis, but the admin dashboard polling blew through the
// Upstash free-tier request quota (which zeroed the dashboard and 500'd the
// checker). Postgres has no per-request quota, so metrics now live here alongside
// the other durable analytics (claim_events, saved cookies). High-frequency Redis
// counters that are genuinely ephemeral (rate limiting, live totals) stay on Redis.

export type CheckOutcome = "alive" | "dead" | "error"

export type MetricsSnapshot = {
  total: number
  alive: number
  dead: number
  error: number
  rateLimitBlocks: number
  gatewayCompletions: number
  runs: number
  avgLatencyMs: number
  firstSeen: number | null
  lastSeen: number | null
  // Free-generator analytics.
  generationsCompleted: number // total accounts successfully handed out
  generationsByService: Record<string, number> // per service breakdown
  totalUsers: number // distinct visitor IPs
  errorsByCategory: Record<string, number>
  perDay: { day: string; total: number; alive: number; dead: number; error: number }[]
  perHour: { hour: string; total: number; alive: number; dead: number; error: number }[]
  recentEvents: RecentEvent[]
}

export type RecentEvent = {
  ts: number
  outcome: CheckOutcome
  category?: CheckErrorCategory
  count: number
  alive: number
  dead: number
  error: number
  durationMs?: number
}

const RATE_LIMIT_BLOCKS = "ratelimit_blocks" // metric_counters.name
const GATEWAY_COMPLETIONS = "gateway_completions" // metric_counters.name

export async function recordGatewayCompletion(): Promise<void> {
  if (!dbEnabled || !sql) return
  try {
    await sql`INSERT INTO metric_counters (name, value) VALUES (${GATEWAY_COMPLETIONS}, 1) ON CONFLICT (name) DO UPDATE SET value = metric_counters.value + 1`
  } catch (err) {
    console.log("[v0] recordGatewayCompletion failed (non-fatal):", (err as Error)?.message)
  }
}
const ERRCAT_PREFIX = "errcat:" // metric_counters.name prefix for lifetime error categories

// How long detailed per-run rows are retained. The dashboard trends only look back
// 7 days (per-day) / 24h (per-hour) / last 100 events, so 45 days is a generous
// buffer. Lifetime totals live in the fixed-size metric_totals rollup, so pruning
// old detail rows keeps metric_runs BOUNDED (≈ 45 days of activity) no matter how
// many millions of cookies get checked — this is what keeps us under Neon's free
// storage cap forever. Stale visitor rows are pruned too (lifetime unique count is
// preserved in the rollup, independent of these rows).
const RUN_RETENTION_DAYS = 45
const USER_RETENTION_DAYS = 180
// Fraction of writes that opportunistically trigger a prune. ~2% means retention
// runs roughly once per 50 checks with zero cron/scheduler — cheap and self-healing.
const PRUNE_PROBABILITY = 0.02

// Hash visitor IPs before storing so we keep distinct-user counts without ever
// persisting a raw IP (privacy-preserving, same intent as the old Redis HLL).
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex")
}

// In-process record of IPs already counted recently, so a bulk run (which fires one
// request per 10-cookie chunk → hundreds of requests from ONE visitor) upserts that
// visitor at most once per window instead of hundreds of times. Module-level, so it
// is shared across all requests on a warm instance. Bounded to avoid unbounded growth.
const recentlySeenIps = new Map<string, number>()
const USER_DEDUP_MS = 5 * 60_000
const MAX_SEEN_IPS = 20_000

// Opportunistic retention: delete detail rows older than the retention windows.
// Bounded WHERE clauses; fire-and-forget so it never blocks a check.
async function maybePruneOldRows(): Promise<void> {
  if (!sql || Math.random() >= PRUNE_PROBABILITY) return
  try {
    await sql`DELETE FROM metric_runs WHERE created_at < now() - (${RUN_RETENTION_DAYS} || ' days')::interval`
    await sql`DELETE FROM metric_users WHERE last_seen < now() - (${USER_RETENTION_DAYS} || ' days')::interval`
  } catch (err) {
    console.log("[v0] metrics prune failed (non-fatal):", (err as Error)?.message)
  }
}

// Records the result of a batch (or single) check run. `category` is only set
// for the error portion. Counts are aggregated so a 200-cookie batch is one run.
export async function recordChecks(opts: {
  total: number
  alive: number
  dead: number
  error: number
  errorCategories?: Partial<Record<CheckErrorCategory, number>>
  durationMs?: number
}): Promise<void> {
  if (!dbEnabled || !sql) return
  const outcome: CheckOutcome =
    opts.alive >= opts.dead && opts.alive >= opts.error ? "alive" : opts.error > opts.dead ? "error" : "dead"
  const durationMs =
    typeof opts.durationMs === "number" && opts.durationMs >= 0 ? Math.round(opts.durationMs) : null
  // Only keep the categories that actually occurred, as a compact JSON object.
  const categories: Record<string, number> = {}
  if (opts.errorCategories) {
    for (const [cat, n] of Object.entries(opts.errorCategories)) {
      if (n && n > 0) categories[cat] = n
    }
  }
  const categoriesJson = Object.keys(categories).length > 0 ? JSON.stringify(categories) : null
  const catNames = Object.keys(categories)
  const catValues = Object.values(categories)

  try {
    await Promise.all([
      // (1) BOUNDED detail row — drives only the recent TRENDS (per-day/hour, last
      // 100 events). Old rows are pruned, so this table never grows without limit.
      sql`
        INSERT INTO metric_runs (total, alive, dead, error, duration_ms, outcome, error_categories)
        VALUES (${opts.total}, ${opts.alive}, ${opts.dead}, ${opts.error}, ${durationMs}, ${outcome}, ${categoriesJson})
      `,
      // (2) FIXED-SIZE lifetime rollup — the single source of truth for all-time
      // totals/latency/first-last activity. One row, one cheap UPDATE per run, so
      // all-time stats survive detail-row pruning and cost nothing to read.
      sql`
        UPDATE metric_totals SET
          runs = runs + 1,
          total = total + ${opts.total},
          alive = alive + ${opts.alive},
          dead = dead + ${opts.dead},
          error = error + ${opts.error},
          duration_sum = duration_sum + ${durationMs ?? 0},
          duration_count = duration_count + ${durationMs == null ? 0 : 1},
          first_seen = COALESCE(first_seen, now()),
          last_seen = now()
        WHERE id = 1
      `,
      // (3) Lifetime error categories as compact counters (only when errors occur).
      catNames.length > 0
        ? sql`
            INSERT INTO metric_counters (name, value)
            SELECT ${ERRCAT_PREFIX} || k, v::bigint
            FROM unnest(${catNames}::text[], ${catValues}::int[]) AS t(k, v)
            ON CONFLICT (name) DO UPDATE SET value = metric_counters.value + EXCLUDED.value
          `
        : Promise.resolve(),
    ])
  } catch (err) {
    // Metrics must never break a check.
    console.log("[v0] recordChecks failed (non-fatal):", (err as Error)?.message)
  }

  // Self-healing retention (occasional, off the hot path).
  void maybePruneOldRows()
}

export async function recordRateLimitBlock(): Promise<void> {
  if (!dbEnabled || !sql) return
  try {
    await sql`
      INSERT INTO metric_counters (name, value) VALUES (${RATE_LIMIT_BLOCKS}, 1)
      ON CONFLICT (name) DO UPDATE SET value = metric_counters.value + 1
    `
  } catch (err) {
    console.log("[v0] recordRateLimitBlock failed (non-fatal):", (err as Error)?.message)
  }
}

// Records ONE completed free-account generation (an account was actually handed
// out). Fire-and-forget so it can never slow or break a claim.
export async function recordGeneration(service: string): Promise<void> {
  if (!dbEnabled || !sql) return
  try {
    await sql`INSERT INTO metric_generations (service) VALUES (${service || "netflix"})`
  } catch (err) {
    console.log("[v0] recordGeneration failed (non-fatal):", (err as Error)?.message)
  }
}

// Adds a visitor IP (hashed) to the distinct-users table. UPSERT keeps one row per
// unique visitor and refreshes last_seen. Fire-and-forget.
//
// Deduped in-process: a bulk run fires one request per 10-cookie chunk, so without
// this a single visitor would upsert hundreds of times per run. We skip the write if
// we've already recorded this IP within USER_DEDUP_MS on this instance. When a row is
// genuinely NEW (detected via `xmax = 0`), we bump the lifetime unique-user counter in
// the rollup so the all-time distinct count survives pruning of stale visitor rows.
export async function recordUser(ip: string): Promise<void> {
  if (!dbEnabled || !sql || !ip) return
  const h = hashIp(ip)
  const now = Date.now()
  const last = recentlySeenIps.get(h)
  if (last && now - last < USER_DEDUP_MS) return
  // Keep the dedup map bounded on long-lived instances.
  if (recentlySeenIps.size >= MAX_SEEN_IPS) recentlySeenIps.clear()
  recentlySeenIps.set(h, now)
  try {
    const rows = (await sql`
      INSERT INTO metric_users (ip_hash, first_seen, last_seen)
      VALUES (${h}, now(), now())
      ON CONFLICT (ip_hash) DO UPDATE SET last_seen = now()
      RETURNING (xmax = 0) AS inserted
    `) as { inserted: boolean }[]
    if (rows?.[0]?.inserted) {
      await sql`UPDATE metric_totals SET unique_users = unique_users + 1 WHERE id = 1`
    }
  } catch (err) {
    console.log("[v0] recordUser failed (non-fatal):", (err as Error)?.message)
  }
}

// Wipes all analytics rows. Used by the admin "danger zone".
export async function resetMetrics(): Promise<boolean> {
  if (!dbEnabled || !sql) return false
  try {
    // Clear detail + counters, then zero the singleton rollup (TRUNCATE would drop
    // the singleton row entirely; a reset should leave it at zeros).
    await sql`TRUNCATE metric_runs, metric_generations, metric_users, metric_counters`
    await sql`
      UPDATE metric_totals SET
        runs = 0, total = 0, alive = 0, dead = 0, error = 0,
        duration_sum = 0, duration_count = 0, unique_users = 0,
        first_seen = NULL, last_seen = NULL
      WHERE id = 1
    `
    // Forget recently-seen IPs so the next visitors are recounted after a wipe.
    recentlySeenIps.clear()
    // Drop the cached snapshot so the dashboard reflects the wipe immediately rather
    // than serving stale numbers for up to the cache TTL.
    metricsCache = null
    metricsInflight = null
    return true
  } catch (err) {
    console.log("[v0] resetMetrics failed:", (err as Error)?.message)
    return false
  }
}

export const emptySnapshot: MetricsSnapshot = {
  total: 0,
  alive: 0,
  dead: 0,
  error: 0,
  rateLimitBlocks: 0,
  gatewayCompletions: 0,
  runs: 0,
  avgLatencyMs: 0,
  firstSeen: null,
  lastSeen: null,
  generationsCompleted: 0,
  generationsByService: {},
  totalUsers: 0,
  errorsByCategory: {},
  perDay: [],
  perHour: [],
  recentEvents: [],
}

// Short-lived in-process cache for the metrics snapshot. The admin dashboard polls
// every 30s; caching for METRICS_TTL_MS collapses all polls (across every viewer,
// since this is module-level on a warm lambda) into at most one DB read per window.
// At 60s (> the 30s poll interval) most polls are served from cache, so Neon is
// queried at most ~once/minute per warm instance while the dashboard is open —
// minimizing compute time (Neon's free-tier budget) without making the panel feel
// stale. A failed read is cached briefly too so a struggling DB isn't re-hit.
const METRICS_TTL_MS = 60_000
let metricsCache: { at: number; snapshot: MetricsSnapshot } | null = null
let metricsInflight: Promise<MetricsSnapshot> | null = null

export async function getMetrics(): Promise<MetricsSnapshot> {
  if (!dbEnabled || !sql) return emptySnapshot

  const now = Date.now()
  if (metricsCache && now - metricsCache.at < METRICS_TTL_MS) return metricsCache.snapshot
  // Collapse concurrent callers (multiple polls/tabs hitting a cold cache at once)
  // onto a SINGLE in-flight read instead of each firing its own query batch.
  if (metricsInflight) return metricsInflight

  metricsInflight = (async () => {
    try {
      const snapshot = await readMetrics()
      metricsCache = { at: Date.now(), snapshot }
      return snapshot
    } catch (err) {
      // A metrics read must NEVER take down the admin panel. Degrade to an empty
      // snapshot so the page still renders instead of 500ing, and cache it briefly
      // so a struggling DB isn't re-hit on every 5s poll. Logged for observability.
      console.log("[v0] getMetrics failed, returning empty snapshot:", (err as Error)?.message)
      metricsCache = { at: Date.now(), snapshot: emptySnapshot }
      return emptySnapshot
    } finally {
      metricsInflight = null
    }
  })()
  return metricsInflight
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0)

async function readMetrics(): Promise<MetricsSnapshot> {
  if (!sql) return emptySnapshot

  const [totalsRows, catRows, genRows, blocksRows, gatewayRows, perDayRows, perHourRows, recentRows] =
    await Promise.all([
      // All-time totals + latency + first/last activity + distinct users, read from
      // the FIXED-SIZE rollup — a single-row lookup whose cost never grows with usage.
      sql`
        SELECT
          runs, total, alive, dead, error,
          duration_sum AS latency_sum,
          duration_count AS latency_count,
          unique_users,
          EXTRACT(EPOCH FROM first_seen) * 1000 AS first_seen,
          EXTRACT(EPOCH FROM last_seen) * 1000 AS last_seen
        FROM metric_totals WHERE id = 1
      `,
      // Lifetime error categories from compact counter rows (name = 'errcat:<cat>').
      sql`
        SELECT substring(name from ${ERRCAT_PREFIX.length + 1}) AS category, value AS count
        FROM metric_counters WHERE name LIKE ${ERRCAT_PREFIX + "%"}
      `,
      sql`SELECT service, COUNT(*)::bigint AS count FROM metric_generations GROUP BY service`,
      sql`SELECT value FROM metric_counters WHERE name = ${RATE_LIMIT_BLOCKS}`,
      sql`SELECT value FROM metric_counters WHERE name = ${GATEWAY_COMPLETIONS}`,
      // Per-day buckets for the last 7 days (UTC), aggregated in SQL.
      sql`
        SELECT
          to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COALESCE(SUM(total), 0)::int AS total,
          COALESCE(SUM(alive), 0)::int AS alive,
          COALESCE(SUM(dead), 0)::int  AS dead,
          COALESCE(SUM(error), 0)::int AS error
        FROM metric_runs
        WHERE created_at >= now() - interval '7 days'
        GROUP BY day
      `,
      // Per-hour buckets for the last 24h (UTC).
      sql`
        SELECT
          to_char(date_trunc('hour', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS hour,
          COALESCE(SUM(total), 0)::int AS total,
          COALESCE(SUM(alive), 0)::int AS alive,
          COALESCE(SUM(dead), 0)::int  AS dead,
          COALESCE(SUM(error), 0)::int AS error
        FROM metric_runs
        WHERE created_at >= now() - interval '24 hours'
        GROUP BY hour
      `,
      // Most recent 100 runs for the live event feed.
      sql`
        SELECT
          EXTRACT(EPOCH FROM created_at) * 1000 AS ts,
          outcome, total, alive, dead, error, duration_ms, error_categories
        FROM metric_runs
        ORDER BY created_at DESC
        LIMIT 100
      `,
    ])

  const t = (totalsRows as Record<string, unknown>[])[0] ?? {}
  const latencySum = num(t.latency_sum)
  const latencyCount = num(t.latency_count)

  const errorsByCategory = Object.fromEntries(
    (catRows as { category: string; count: unknown }[]).map((r) => [r.category, num(r.count)]),
  )
  const generationsByService = Object.fromEntries(
    (genRows as { service: string; count: unknown }[]).map((r) => [r.service, num(r.count)]),
  )
  const generationsCompleted = Object.values(generationsByService).reduce((a, b) => a + b, 0)
  const totalUsers = num(t.unique_users)
  const rateLimitBlocks = num((blocksRows as { value: unknown }[])[0]?.value)
  const gatewayCompletions = num((gatewayRows as { value: unknown }[])[0]?.value)

  // Fill any missing day/hour buckets with zeros so the charts show a continuous
  // window even before there's data for every slot.
  const nowD = new Date()
  const dayIndex = new Map(
    (perDayRows as Record<string, unknown>[]).map((r) => [String(r.day), r]),
  )
  const perDay = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(nowD)
    d.setUTCDate(d.getUTCDate() - (6 - i))
    const day = d.toISOString().slice(0, 10)
    const row = dayIndex.get(day)
    return {
      day,
      total: num(row?.total),
      alive: num(row?.alive),
      dead: num(row?.dead),
      error: num(row?.error),
    }
  })

  const hourIndex = new Map(
    (perHourRows as Record<string, unknown>[]).map((r) => [String(r.hour), r]),
  )
  const perHour = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(nowD)
    d.setUTCHours(d.getUTCHours() - (23 - i))
    const hour = d.toISOString().slice(0, 13)
    const row = hourIndex.get(hour)
    return {
      hour,
      total: num(row?.total),
      alive: num(row?.alive),
      dead: num(row?.dead),
      error: num(row?.error),
    }
  })

  const recentEvents: RecentEvent[] = (recentRows as Record<string, unknown>[]).map((r) => {
    const cats = (r.error_categories as Record<string, number> | null) ?? null
    // Surface the dominant error category on the event (matches the old shape).
    let category: CheckErrorCategory | undefined
    if (cats) {
      let best = -1
      for (const [k, v] of Object.entries(cats)) {
        if (num(v) > best) {
          best = num(v)
          category = k as CheckErrorCategory
        }
      }
    }
    const durationMs = r.duration_ms == null ? undefined : num(r.duration_ms)
    return {
      ts: num(r.ts),
      outcome: (r.outcome as CheckOutcome) ?? "dead",
      category,
      count: num(r.total),
      alive: num(r.alive),
      dead: num(r.dead),
      error: num(r.error),
      durationMs,
    }
  })

  return {
    total: num(t.total),
    alive: num(t.alive),
    dead: num(t.dead),
    error: num(t.error),
    rateLimitBlocks,
    gatewayCompletions,
    runs: num(t.runs),
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    firstSeen: t.first_seen == null ? null : num(t.first_seen),
    lastSeen: t.last_seen == null ? null : num(t.last_seen),
    generationsCompleted,
    generationsByService,
    totalUsers,
    errorsByCategory,
    perDay,
    perHour,
    recentEvents,
  }
}
