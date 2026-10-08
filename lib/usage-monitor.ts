// Lightweight, ZERO-external-call usage monitor for Neon + Upstash Redis.
//
// It simply tallies client invocations on the CURRENT warm instance — no extra
// queries, no extra Redis commands, so the monitor itself can never push you
// toward a free-tier cap. Because counters live in module scope, they:
//   • reset on every cold start, and
//   • are NOT summed across the many concurrent serverless instances that may be
//     serving traffic at once.
// So treat these numbers as a LIVE SAMPLE of how hard one warm instance is
// working ("are we hammering the DB right now?"), not as your exact monthly bill.
// The projected per-day / per-month figures extrapolate the current instance's
// rate, which is the useful early-warning signal for "thousands of users".

// Upstash free-tier reference: 500,000 commands / month. Used only to render a
// rough "budget used" gauge from the projected monthly rate. Adjust if your plan
// differs — it is a display reference, not an enforced limit.
export const REDIS_MONTHLY_COMMAND_BUDGET = 500_000

export type UsageSnapshot = {
  instanceStartedAt: number
  uptimeMs: number
  neon: {
    // Total queries issued through the shared `sql` client on this instance.
    queries: number
    perMinute: number
    perDayEstimate: number
  }
  redis: {
    // Total commands issued through the shared `redis` client on this instance.
    commands: number
    perMinute: number
    perDayEstimate: number
    monthlyBudget: number
    // Projected monthly commands as a % of the reference budget (0–100, clamped).
    monthlyBudgetUsedPct: number
  }
}

const startedAt = Date.now()
let neonQueries = 0
let redisCommands = 0

// Called by the wrapped Neon client on every query. Kept trivially cheap.
export function bumpNeon(): void {
  neonQueries++
}

// Called by the wrapped Redis client on every command.
export function bumpRedis(): void {
  redisCommands++
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function getUsageSnapshot(): UsageSnapshot {
  const now = Date.now()
  const uptimeMs = Math.max(1, now - startedAt)
  const minutes = uptimeMs / 60_000

  const neonPerMin = neonQueries / minutes
  const redisPerMin = redisCommands / minutes
  const redisPerDay = redisPerMin * 60 * 24
  const redisPerMonth = redisPerDay * 30

  return {
    instanceStartedAt: startedAt,
    uptimeMs,
    neon: {
      queries: neonQueries,
      perMinute: round1(neonPerMin),
      perDayEstimate: Math.round(neonPerMin * 60 * 24),
    },
    redis: {
      commands: redisCommands,
      perMinute: round1(redisPerMin),
      perDayEstimate: Math.round(redisPerDay),
      monthlyBudget: REDIS_MONTHLY_COMMAND_BUDGET,
      monthlyBudgetUsedPct: Math.min(
        100,
        Math.round((redisPerMonth / REDIS_MONTHLY_COMMAND_BUDGET) * 100),
      ),
    },
  }
}
