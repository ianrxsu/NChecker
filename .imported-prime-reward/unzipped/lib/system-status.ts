import { redis, redisEnabled } from "./redis"
import { getUsageSnapshot, type UsageSnapshot } from "./usage-monitor"

// Runtime health/config snapshot for the admin panel's "System" view. Reports
// what is wired up (without ever exposing secret values) plus a live Redis ping.

export type ServiceState = "ok" | "degraded" | "off"

export type SystemStatus = {
  redis: {
    state: ServiceState
    pingMs: number | null
    label: string
  }
  upstream: {
    state: ServiceState
    mode: "live" | "demo"
    label: string
  }
  auth: {
    state: ServiceState
    dedicatedSecret: boolean
    label: string
  }
  rateLimit: {
    cookiesPerMinute: number
    loginAttemptsPerMinute: number
  }
  runtime: {
    env: string
    region: string
    nodeVersion: string
  }
  // In-process Neon/Redis usage sample (see lib/usage-monitor.ts). Per warm
  // instance, so it's a live load signal rather than a global billing total.
  usage: UsageSnapshot
}

// Safe default used by the admin page if status collection ever throws, so the
// panel always renders. Reflects an "unknown/degraded" but non-crashing state.
export const fallbackSystemStatus: SystemStatus = {
  redis: { state: "off", pingMs: null, label: "Unknown" },
  upstream: { state: "ok", mode: "live", label: "Native Netflix checker" },
  auth: { state: "degraded", dedicatedSecret: false, label: "Unknown" },
  rateLimit: { cookiesPerMinute: 600, loginAttemptsPerMinute: 5 },
  runtime: {
    env: process.env.NODE_ENV ?? "unknown",
    region: process.env.VERCEL_REGION ?? "local",
    nodeVersion: process.version,
  },
  usage: getUsageSnapshot(),
}

// Cache the Redis connectivity probe. The admin dashboard polls system status,
// and an uncached ping here spent a Redis command on EVERY poll per open tab
// (~2,880/day/tab) purely to light up a "Connected" indicator — a top driver of
// Upstash's 500k/mo command quota. A 60s TTL (aligned with the dashboard poll and
// the metrics/claims caches) collapses those into at most one ping per minute per
// warm instance while still reflecting real connectivity within a minute.
const PING_TTL_MS = 60_000
let pingCache: { at: number; pingMs: number | null; state: ServiceState } | null = null

async function getRedisPing(): Promise<{ pingMs: number | null; state: ServiceState }> {
  if (!redisEnabled) return { pingMs: null, state: "off" }
  const now = Date.now()
  if (pingCache && now - pingCache.at < PING_TTL_MS) {
    return { pingMs: pingCache.pingMs, state: pingCache.state }
  }
  let pingMs: number | null = null
  let state: ServiceState = "off"
  try {
    const start = Date.now()
    await redis.ping()
    pingMs = Date.now() - start
    state = "ok"
  } catch {
    state = "degraded"
  }
  pingCache = { at: Date.now(), pingMs, state }
  return { pingMs, state }
}

export async function getSystemStatus(): Promise<SystemStatus> {
  // Cached Redis ping so the panel reflects real connectivity without spending a
  // Redis command on every dashboard poll (see getRedisPing).
  const { pingMs, state: redisState } = await getRedisPing()

  // The checker now talks to Netflix directly (no third-party API), so it is
  // always "live" — there is no API key to configure.
  const upstreamLive = true
  const dedicatedSecret = Boolean(process.env.ADMIN_SESSION_SECRET)

  return {
    redis: {
      state: redisState,
      pingMs,
      label:
        redisState === "ok"
          ? "Connected"
          : redisState === "degraded"
            ? "Unreachable"
            : "Not configured",
    },
    upstream: {
      state: upstreamLive ? "ok" : "degraded",
      mode: upstreamLive ? "live" : "demo",
      label: "Native Netflix checker",
    },
    auth: {
      state: dedicatedSecret ? "ok" : "degraded",
      dedicatedSecret,
      label: dedicatedSecret ? "Dedicated session secret" : "Falling back to password",
    },
    rateLimit: {
      cookiesPerMinute: 600,
      loginAttemptsPerMinute: 5,
    },
    runtime: {
      env: process.env.NODE_ENV ?? "unknown",
      region: process.env.VERCEL_REGION ?? "local",
      nodeVersion: process.version,
    },
    // Snapshot the counters at read time. This read itself issues one Redis ping
    // (above) and the metrics query elsewhere, which the monitor already counts.
    usage: getUsageSnapshot(),
  }
}
