import { NextResponse } from "next/server"
import { scrapeProxies, filterAliveProxies } from "@/lib/proxy-scraper"
import type { ParsedProxy } from "@/lib/proxies"
import { redis, redisEnabled } from "@/lib/redis"
import { getCheckerVisibility, PUBLIC_CHECKER_SERVICES, isCheckerVisible } from "@/lib/checker-visibility"
import { isAdminAuthenticated } from "@/lib/admin-auth"

// Public proxy scraping is the single biggest Fluid CPU drain: each POST fetches
// ~25 aggregator lists and live-tests hundreds of proxies for up to 60s. It must
// only run when there is a publicly visible checker that actually needs proxies —
// otherwise returning visitors, cached tabs, extensions, and bots keep triggering
// full sweeps even after an admin has hidden every public checker. Admins are
// always allowed so the panel's own checkers keep working.
async function publicProxyWorkAllowed(): Promise<boolean> {
  if (await isAdminAuthenticated()) return true
  const vis = await getCheckerVisibility()
  return vis.autoProxyScrapeEnabled && PUBLIC_CHECKER_SERVICES.some((svc) => isCheckerVisible(vis, svc))
}

export const runtime = "nodejs"
// One scrape refill plus an in-memory test budget, with margin.
export const maxDuration = 60

// PUBLIC, EPHEMERAL proxy source. The client polls this repeatedly while a run is
// active and keeps the survivors in its OWN browser-session memory — nothing here
// is ever written to the database. Free proxies die within minutes, so persisting
// them is pointless; testing a fresh slice live and handing the fastest ones
// straight back to the caller is both faster and more accurate.
//
// To avoid re-fetching every source list on every poll (wasteful and slow), the
// merged candidate list is cached per warm process for a short TTL; each poll just
// reachability-TESTS a different rotating slice of it, so the client steadily
// accumulates freshly-verified, fastest-first exit IPs.
let cachedCandidates: ParsedProxy[] = []
let cachedAt = 0
let refetching = false
// TTL before we kick off a background refresh of the candidate list. Kept well
// above the 40s sweep budget so a poll never triggers a blocking re-scrape mid-
// stream; instead the refresh runs in the background and the NEXT poll uses the
// fresh list. Old candidates are kept alive until the refresh completes so every
// poll always has something to test.
const CANDIDATE_TTL_MS = 120_000

// CROSS-INVOCATION cache of the SCRAPED candidate list (best-effort, via Redis).
// The in-memory cache above only survives within a single warm process — on
// Vercel, functions cold-start constantly, so without this every cold poll would
// re-fetch all ~25 source aggregators (slow + the biggest avoidable cost). Caching
// the merged raw candidate list in Redis lets a cold start reuse a recent scrape
// instead of re-scraping. Survivors are still re-tested live each poll (free
// proxies decay fast); only the SOURCE-LIST fetch is cached.
const REDIS_CANDIDATES_KEY = "proxies:live:candidates:v1"
const REDIS_CANDIDATES_TTL_S = 180

async function readCandidateCache(): Promise<ParsedProxy[] | null> {
  if (!redisEnabled) return null
  try {
    const raw = (await redis.get(REDIS_CANDIDATES_KEY)) as ParsedProxy[] | null
    return Array.isArray(raw) && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function writeCandidateCache(items: ParsedProxy[]): void {
  if (!redisEnabled || items.length === 0) return
  // Cap what we persist so the Redis value stays small; the rotating slice only
  // tests SLICE candidates per poll anyway, but keep a broad pool to rotate over.
  const slice = items.slice(0, 4_000)
  void redis.set(REDIS_CANDIDATES_KEY, slice, { ex: REDIS_CANDIDATES_TTL_S }).catch(() => {
    // best-effort cache only
  })
}
// How many candidates to reachability-test per poll. The client polls this
// continuously while a large run is active, so each poll scrapes + Netflix-tests
// a fresh rotating batch of exactly this many candidates and returns the WORKING
// (fastest-first) survivors. Raised to 1000 so each sweep yields a large pool of
// exit IPs to spread checks across — pool SIZE is the main throughput driver.
const SLICE = 250

// Returns the current candidate list immediately and, if it is stale, fires a
// background refresh so the NEXT poll gets a fresh list without blocking this one.
async function getCandidates(): Promise<ParsedProxy[]> {
  const now = Date.now()
  const stale = now - cachedAt > CANDIDATE_TTL_MS
  if (stale && !refetching && cachedCandidates.length > 0) {
    // Background refresh: the current poll keeps using the existing list while
    // the next scrape completes in the background — no blocking on this request.
    refetching = true
    void scrapeProxies({ limit: 4_000 })
      .then(({ parsed }) => {
        if (parsed.length > 0) { cachedCandidates = parsed; cachedAt = Date.now(); writeCandidateCache(parsed) }
      })
      .catch(() => { /* best-effort */ })
      .finally(() => { refetching = false })
  }
  if (cachedCandidates.length === 0) {
    // COLD START: before scraping, try the cross-invocation Redis cache so a fresh
    // process reuses a recent merged scrape instead of re-fetching every source.
    const cached = await readCandidateCache()
    if (cached) {
      cachedCandidates = cached
      // Slightly stale so the background full refresh below still kicks in on the
      // next poll, keeping the pool fresh without blocking this request.
      cachedAt = Date.now() - (CANDIDATE_TTL_MS - 5_000)
      return cachedCandidates
    }
    // No cache: don't block on all ~25 aggregators (the slowest can take the full
    // 12s fetch timeout). Fetch only the small, high-signal pre-checked lists first
    // so we have candidates to test — and therefore stream verified proxies to the
    // client — within ~1-2s. Then upgrade to the full merged list in the background
    // so subsequent polls test from the broadest pool.
    const { parsed } = await scrapeProxies({ limit: 4_000, priorityOnly: true })
    if (parsed.length > 0) {
      cachedCandidates = parsed
      cachedAt = Date.now() - (CANDIDATE_TTL_MS - 5_000)
      writeCandidateCache(parsed)
    }
    if (!refetching) {
      refetching = true
      void scrapeProxies({ limit: 4_000 })
        .then(({ parsed: full }) => {
          if (full.length > 0) { cachedCandidates = full; cachedAt = Date.now(); writeCandidateCache(full) }
        })
        .catch(() => { /* best-effort */ })
        .finally(() => { refetching = false })
    }
  }
  return cachedCandidates
}

export async function POST() {
  if (!(await publicProxyWorkAllowed())) {
    return NextResponse.json({ error: "Automatic public proxy scraping is disabled. Provide your own proxies." }, { status: 403 })
  }
  const candidates = await getCandidates()
  if (candidates.length === 0) {
    return NextResponse.json({ proxies: [], tested: 0, alive: 0, dead: 0 })
  }

  // Each request gets its OWN random starting offset so concurrent sessions from
  // different clients probe non-overlapping windows of the candidate list instead
  // of all sharing the same server-level rotation counter and retesting the same
  // proxies. Wrapping around is handled by the modular slice logic below.
  const start = Math.floor(Math.random() * candidates.length)
  const slice = candidates.slice(start, start + SLICE)
  if (slice.length < SLICE) slice.push(...candidates.slice(0, SLICE - slice.length))

  // STREAM survivors as NDJSON: one JSON object per line, flushed the instant a
  // proxy passes its Netflix test. The client reads the stream incrementally and
  // adds each verified proxy to its pool RIGHT AWAY — so a run gets fresh exit IPs
  // within the first few hundred ms instead of waiting for the full 1000-candidate
  // sweep (or the 40s budget) to complete. Every emitted proxy is still fully
  // tested; we just stop waiting for the slow/dead candidates.
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
        } catch {
          // controller closed (client navigated away) — ignore.
        }
      }
      try {
        await filterAliveProxies(slice, {
          concurrency: 500, // probe many candidates at once so the first survivor surfaces fast
          slowMs: 4_000,
          budgetMs: 40_000, // within the route's 60s maxDuration, with margin
          // FAST PROBE: a SINGLE attempt with a short timeout. The live sweep re-polls
          // continuously, so accuracy from multi-attempt retries is unnecessary here —
          // a proxy that blips this sweep is retested seconds later. Single-attempt
          // probing condemns dead proxies in one ~4.5s timeout instead of up to ~19s
          // (3 attempts), which is the single biggest factor in how quickly the FIRST
          // working proxy appears and the run can start.
          maxProbeAttempts: 1,
          probeTimeoutMs: 4_500,
          // INCLUDE flagged (403/429) proxies. Free proxies that pass a *clean*
          // Netflix probe are rare, so clean-only filtering starved the pool and
          // caused the endless RETRYING. The CHECKER already fails over off a flagged
          // proxy to a clean one (so no 403 leaks to the user), and flagged proxies
          // sort behind clean ones via a latency penalty. Admitting them keeps the
          // pool large enough to sustain many parallel lanes.
          includeFlagged: true,
          // Flush each survivor the moment it's verified — this is what makes the
          // response incremental instead of one big batch at the end.
          onAlive: (a) =>
            send({
              type: "proxy",
              protocol: a.proxy.protocol,
              host: a.proxy.host,
              port: a.proxy.port,
              latencyMs: Math.round(a.latencyMs),
            }),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Live scrape failed."
        send({ type: "error", error: message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  })
}
