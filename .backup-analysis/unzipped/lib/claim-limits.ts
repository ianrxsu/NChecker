import { redis, redisEnabled } from "./redis"
import type { GeneratorService as Service } from "./check-via-proxies"

// Admin-configurable per-service ACCOUNT-CLAIM limits for the free generator. These
// cap how many free accounts a single visitor (IP + device) can unlock per fixed
// window, on top of the LootLabs gateway — a fairness/abuse guard, not a cost one.
//
// The values live in Redis (like the kill switch) so an admin can retune them from
// the System tab and have it take effect instantly across every serverless instance
// with no redeploy. When Redis is unavailable we fall back to the defaults below.

const KEY = "settings:claim-limits"

// Window units we expose in the admin UI. Counts are always "per <unit>".
export type ClaimWindowUnit = "hour" | "day"
export const WINDOW_SECONDS: Record<ClaimWindowUnit, number> = {
  hour: 60 * 60,
  day: 60 * 60 * 24,
}

export type ClaimLimitConfig = {
  // Max accounts a visitor may unlock per window. Clamped to a sane range on write.
  limit: number
  // Window length in seconds (derived from the chosen unit).
  windowSeconds: number
}

export type ClaimLimits = Record<Service, ClaimLimitConfig>

// Defaults match the original hard-coded behaviour: Netflix 3/hour,
// Prime & Crunchyroll 2/day. Used when nothing is stored or Redis is down.
export const DEFAULT_CLAIM_LIMITS: ClaimLimits = {
  netflix: { limit: 3, windowSeconds: WINDOW_SECONDS.hour },
  prime: { limit: 2, windowSeconds: WINDOW_SECONDS.day },
  crunchyroll: { limit: 2, windowSeconds: WINDOW_SECONDS.day },
}

// Guardrails so a bad/abusive value can't disable the limiter or set an absurd cap.
const MIN_LIMIT = 1
const MAX_LIMIT = 100

const SERVICES: Service[] = ["netflix", "prime", "crunchyroll"]

// Coerces an arbitrary stored/posted value into a valid ClaimLimitConfig, falling
// back to the provided default for any field that's missing or out of range.
function sanitizeConfig(raw: unknown, fallback: ClaimLimitConfig): ClaimLimitConfig {
  if (!raw || typeof raw !== "object") return fallback
  const obj = raw as Record<string, unknown>
  const limitNum = Number(obj.limit)
  const windowNum = Number(obj.windowSeconds)
  // A finite count is CLAMPED into [MIN, MAX] (so 999 → 100, 0 → 1); only a
  // non-numeric value falls back to the default.
  const limit = Number.isFinite(limitNum) ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limitNum))) : fallback.limit
  // Only the two supported windows are allowed; anything else snaps to the default.
  const windowSeconds =
    windowNum === WINDOW_SECONDS.hour || windowNum === WINDOW_SECONDS.day ? windowNum : fallback.windowSeconds
  return { limit, windowSeconds }
}

// Reads the effective limits for all services. Always returns a complete map —
// missing services fall back to their default. Fails OPEN to defaults on any error.
export async function getClaimLimits(): Promise<ClaimLimits> {
  if (!redisEnabled) return DEFAULT_CLAIM_LIMITS
  try {
    const raw = await redis.get<Partial<Record<Service, unknown>>>(KEY)
    if (!raw || typeof raw !== "object") return DEFAULT_CLAIM_LIMITS
    const result = {} as ClaimLimits
    for (const service of SERVICES) {
      result[service] = sanitizeConfig(raw[service], DEFAULT_CLAIM_LIMITS[service])
    }
    return result
  } catch {
    return DEFAULT_CLAIM_LIMITS
  }
}

// Persists a new set of limits (sanitized). Returns the stored, effective map so the
// caller can echo back exactly what took effect.
export async function setClaimLimits(input: Partial<Record<Service, unknown>>): Promise<ClaimLimits> {
  const next = {} as ClaimLimits
  for (const service of SERVICES) {
    next[service] = sanitizeConfig(input?.[service], DEFAULT_CLAIM_LIMITS[service])
  }
  if (redisEnabled) {
    try {
      await redis.set(KEY, next)
    } catch {
      // Best-effort — the caller re-reads if it needs confirmation.
    }
  }
  return next
}

// Human label for a limit, e.g. "3 per hour" / "2 per day". Shared by the limiter
// (shown to blocked users) and the admin UI so they always read identically.
export function formatClaimLabel(limit: number, windowSeconds: number): string {
  if (windowSeconds === WINDOW_SECONDS.hour) return `${limit} per hour`
  if (windowSeconds === WINDOW_SECONDS.day) return `${limit} per day`
  const hours = Math.round(windowSeconds / 3600)
  return `${limit} per ${hours} hours`
}

// Maps a windowSeconds value back to its unit for the admin <select>.
export function unitFromSeconds(windowSeconds: number): ClaimWindowUnit {
  return windowSeconds === WINDOW_SECONDS.day ? "day" : "hour"
}

// Temporary 24-hour passes always use a daily reset, while preserving the
// administrator-configured per-service count.
export async function getTemporaryPassLimits(service: Service): Promise<ClaimLimitConfig> {
  const configured = (await getClaimLimits())[service]
  return { limit: configured.limit, windowSeconds: WINDOW_SECONDS.day }
}
