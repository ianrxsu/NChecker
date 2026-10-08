import { redis, redisEnabled } from "./redis"
import { getCachedConfig, bustConfigCache } from "./config-cache"

// Global "kill switch". When enabled, the root middleware rewrites every public
// page to the maintenance screen. The flag lives in Redis so it takes effect
// instantly across every serverless/edge instance with no redeploy.

const KEY = "site:maintenance"

// Middleware reads this on EVERY public navigation, so we front the Redis read
// with a short in-process cache (see lib/config-cache). A ~30s propagation delay
// when toggling maintenance is imperceptible, and the writer busts its own cache.
const CACHE_KEY = "maintenance-mode"
const CACHE_TTL_MS = 30_000

export type MaintenanceState = {
  enabled: boolean
  // Optional admin-supplied note shown on the maintenance screen.
  message: string | null
  // When the switch was last flipped on (epoch ms), for display in the panel.
  since: number | null
}

const DEFAULT_STATE: MaintenanceState = { enabled: false, message: null, since: null }

// Reads the current kill-switch state. Fails OPEN (site stays up) whenever Redis
// is unavailable — a flaky analytics DB must never take the whole site down.
export async function getMaintenanceState(): Promise<MaintenanceState> {
  if (!redisEnabled) return DEFAULT_STATE
  return getCachedConfig(CACHE_KEY, CACHE_TTL_MS, async () => {
    try {
      const raw = await redis.get<MaintenanceState>(KEY)
      if (!raw || typeof raw !== "object") return DEFAULT_STATE
      return {
        enabled: Boolean(raw.enabled),
        message: typeof raw.message === "string" && raw.message.trim() ? raw.message : null,
        since: typeof raw.since === "number" ? raw.since : null,
      }
    } catch {
      return DEFAULT_STATE
    }
  })
}

// Lightweight boolean read for the hot path (middleware). Same fail-open rule.
export async function isMaintenanceEnabled(): Promise<boolean> {
  const state = await getMaintenanceState()
  return state.enabled
}

// Flips the switch. Persists the message + flip time so the panel and screen can
// show context. Returns the resulting state.
export async function setMaintenanceState(enabled: boolean, message?: string | null): Promise<MaintenanceState> {
  const next: MaintenanceState = {
    enabled,
    message: message && message.trim() ? message.trim() : null,
    since: enabled ? Date.now() : null,
  }
  if (redisEnabled) {
    try {
      await redis.set(KEY, next)
      // Drop this instance's cached value so the admin sees their change immediately
      // (other warm instances converge within CACHE_TTL_MS).
      bustConfigCache(CACHE_KEY)
    } catch {
      // Best-effort — surfaced to the caller via a re-read if needed.
    }
  }
  return next
}
