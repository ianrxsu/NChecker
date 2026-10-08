import { scrapeProxies, filterAliveProxies } from "@/lib/proxy-scraper"
import type { ProxyDialInfo } from "@/lib/proxies"
import { redis, redisEnabled } from "@/lib/redis"

// SERVER-SIDE live proxy source. The browser-based checker scrapes + Netflix-tests
// proxies in its own session (lib/live-proxies.ts), but server-only jobs — chiefly
// the saved-cookie recheck cron — have no browser, so they need their own way to
// obtain fresh, WORKING proxies on demand. This module scrapes the public lists,
// reachability-tests a slice against Netflix, and returns only the fastest live
// survivors as dial info. Nothing is persisted to a database; free proxies die in
// minutes, so survivors are cached briefly (in warm memory + best-effort Redis so
// chunked cron continuations reuse a warm pool instead of re-testing every time).

const MEM_TTL_MS = 3 * 60_000 // survivors considered fresh for ~3 min
const REDIS_KEY = "live-proxies:server:v1"
const REDIS_TTL_S = 180

type AliveWire = { protocol: ProxyDialInfo["protocol"]; host: string; port: number; latencyMs: number }

let memCache: AliveWire[] = []
let memAt = 0
// Coalesce concurrent refreshes (the cron fans out many cookies at once) so we
// scrape + test ONCE, not once per caller.
let inFlight: Promise<AliveWire[]> | null = null

function toDial(items: AliveWire[], limit: number): ProxyDialInfo[] {
  return items
    .slice(0, limit)
    .map((a) => ({
      id: `live:${a.protocol}:${a.host}:${a.port}`,
      protocol: a.protocol,
      host: a.host,
      port: a.port,
      username: null,
      password: null,
      isGateway: false,
    }))
}

async function readRedis(): Promise<AliveWire[] | null> {
  if (!redisEnabled) return null
  try {
    const raw = (await redis.get(REDIS_KEY)) as AliveWire[] | null
    return Array.isArray(raw) && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

async function writeRedis(items: AliveWire[]): Promise<void> {
  if (!redisEnabled || items.length === 0) return
  try {
    await redis.set(REDIS_KEY, items, { ex: REDIS_TTL_S })
  } catch {
    // best-effort cache only
  }
}

// Scrapes a fresh batch and Netflix-tests it, returning fastest-first survivors.
async function refresh(): Promise<AliveWire[]> {
  const { parsed } = await scrapeProxies({ limit: 8_000 })
  if (parsed.length === 0) return []
  // Test a bounded slice within a tight budget so a cron continuation never blows
  // its maxDuration just sourcing proxies.
  const slice = parsed.slice(0, 500)
  const { alive } = await filterAliveProxies(slice, { concurrency: 200, slowMs: 4_000, budgetMs: 25_000 })
  alive.sort((a, b) => a.latencyMs - b.latencyMs)
  const wire: AliveWire[] = alive.map((a) => ({
    protocol: a.proxy.protocol,
    host: a.proxy.host,
    port: a.proxy.port,
    latencyMs: Math.round(a.latencyMs),
  }))
  memCache = wire
  memAt = Date.now()
  void writeRedis(wire)
  return wire
}

// Returns fresh, Netflix-tested, fastest-first proxies for server-side dialing.
// Reuses warm in-memory survivors, then Redis, and only scrapes+tests when both
// are cold/stale. `limit` caps how many are returned (fastest first).
export async function getServerLiveProxies(opts?: { limit?: number }): Promise<ProxyDialInfo[]> {
  const limit = opts?.limit ?? 150

  // 1. Warm in-memory survivors.
  if (memCache.length > 0 && Date.now() - memAt < MEM_TTL_MS) {
    return toDial(memCache, limit)
  }

  // 2. Cross-invocation Redis cache.
  const cached = await readRedis()
  if (cached) {
    memCache = cached
    memAt = Date.now()
    return toDial(cached, limit)
  }

  // 3. Cold: scrape + test once, coalescing concurrent callers.
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null
    })
  }
  const fresh = await inFlight
  return toDial(fresh, limit)
}
