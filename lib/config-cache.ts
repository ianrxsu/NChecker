// Tiny in-process TTL cache for HOT, low-cardinality config reads (maintenance
// mode, public-checker visibility) that would otherwise hit Redis on EVERY public
// page view / middleware run.
//
// Why this exists: those flags are read on essentially every request, but they
// change rarely (an admin flips them occasionally). Reading Redis per page view is
// what burned through the Upstash free-tier command quota — the vast majority of
// those reads came from bots/crawlers/casual browsing, not real product usage.
//
// A serverless instance stays warm for minutes and this cache is module-level, so
// within any TTL window a single warm instance does AT MOST ONE Redis read for a
// given key no matter how many requests it serves. Under traffic that collapses
// thousands of reads into a handful — the command count now scales with time, not
// with page views.
//
// Trade-off: after an admin changes a flag, other warm instances keep serving the
// previous value for up to TTL. That's fine for these flags (a ~30s propagation
// delay on a maintenance/visibility toggle is imperceptible), and the writer busts
// its OWN instance's cache immediately via bustConfigCache() so the admin sees the
// change reflected instantly on their next read.

type Entry = { at: number; value: unknown; inflight: Promise<unknown> | null }

const store = new Map<string, Entry>()

// Returns the cached value for `key` if it's younger than `ttlMs`; otherwise runs
// `load()` (deduping concurrent misses onto one call) and caches the result.
// `load` is responsible for its own fail-open behavior — whatever it resolves to
// is what gets cached, including a safe default when the backing store is down.
export async function getCachedConfig<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value as T
  // Collapse a stampede of concurrent misses (many requests hitting a cold/expired
  // entry at once) onto a SINGLE load instead of each firing its own Redis read.
  if (hit?.inflight) return hit.inflight as Promise<T>

  const inflight = (async () => {
    const value = await load()
    store.set(key, { at: Date.now(), value, inflight: null })
    return value
  })().catch((err) => {
    // Never poison the cache with a rejected promise; clear the in-flight marker so
    // the next call retries. The caller's load() should normally fail open itself.
    const cur = store.get(key)
    if (cur) cur.inflight = null
    throw err
  })

  store.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight })
  return inflight as Promise<T>
}

// Immediately invalidates a key so the very next read reloads from source. Called
// by writers right after they persist a change, so the admin's own instance never
// serves its own stale value.
export function bustConfigCache(key: string): void {
  store.delete(key)
}
