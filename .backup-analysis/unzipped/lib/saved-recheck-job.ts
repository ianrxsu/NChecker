import { redis, redisEnabled } from "@/lib/redis"
import { listAllSavedCookieIds, loadSavedCookiesByIds, removeSavedCookies } from "@/lib/saved-cookies"
import { createProxyPoolChecker } from "@/lib/check-via-proxies"
import { getServerLiveProxies } from "@/lib/server-live-proxies"
import { prepareCookieForCheck } from "@/lib/cookie-utils"

// Background, chunked re-validation of every SAVED cookie against Netflix. The
// saved pool can be thousands of accounts — far more than one serverless
// invocation can check within maxDuration — so the work is split into
// time-budgeted chunks. Each invocation checks as many cookies as it can within
// CHUNK_BUDGET_MS, deletes the ones that come back DEFINITIVELY dead/expired,
// persists progress to Redis, then (if more remain) fires a fire-and-forget
// continuation request to itself. The admin UI just polls the job state, so it
// never blocks and the recheck keeps running in the background.

const JOB_KEY = "saved:recheck:job"
const IDS_KEY = "saved:recheck:ids" // JSON snapshot of all ids for the active job
const JOB_TTL_S = 60 * 60 // keep the last job visible for an hour

// Same watchdog window as the proxy sweep: if a "running" recheck hasn't been
// touched within this long, its continuation chain was lost and the status poll
// re-fires a chunk to self-heal.
const STALE_RESUME_MS = 15_000

// Per-chunk concurrency. Each is a full Netflix check (heavier than a proxy
// probe), so this is more conservative than the proxy sweep's fan-out.
export const RECHECK_CONCURRENCY = 8
// Wall-clock budget per invocation; stays under the route maxDuration (60s) so
// there's headroom to persist progress and fire the continuation.
const CHUNK_BUDGET_MS = 45_000

export type SavedRecheckJob = {
  id: string
  // "paused"/"stopped" are user-driven; a page refresh pauses (see the admin UI).
  status: "running" | "paused" | "stopped" | "done" | "error"
  total: number
  done: number
  alive: number
  deleted: number
  source: "manual" | "cron"
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  error?: string
}

export async function getSavedRecheckJob(): Promise<SavedRecheckJob | null> {
  if (!redisEnabled) return null
  return (await redis.get<SavedRecheckJob>(JOB_KEY)) ?? null
}

async function saveJob(job: SavedRecheckJob): Promise<void> {
  if (!redisEnabled) return
  job.updatedAt = Date.now()
  await redis.set(JOB_KEY, job, { ex: JOB_TTL_S })
}

// Saves chunk progress WITHOUT clobbering a pause/stop the user set mid-chunk.
// Re-reads the control status first; if paused/stopped, persists our counters
// under that status and reports it so the chunk bails.
async function saveProgress(job: SavedRecheckJob): Promise<SavedRecheckJob["status"]> {
  if (!redisEnabled) return job.status
  const cur = await redis.get<SavedRecheckJob>(JOB_KEY)
  if (cur && (cur.status === "paused" || cur.status === "stopped")) {
    const merged: SavedRecheckJob = { ...job, status: cur.status, finishedAt: cur.finishedAt, updatedAt: Date.now() }
    await redis.set(JOB_KEY, merged, { ex: JOB_TTL_S })
    return cur.status
  }
  job.updatedAt = Date.now()
  await redis.set(JOB_KEY, job, { ex: JOB_TTL_S })
  return "running"
}

// A job is "alive" (still being worked) if it's running and was touched
// recently, so we don't start a second recheck on top of a live one while still
// letting a stalled/crashed job be superseded.
export function isRecheckAlive(job: SavedRecheckJob | null): boolean {
  return Boolean(job && job.status === "running" && Date.now() - job.updatedAt < 90_000)
}

// Starts a fresh recheck: snapshots every saved-cookie id, resets counters, and
// returns the new job. Does NOT check anything itself — the caller kicks off the
// first chunk (so it can wrap it in waitUntil).
export async function startSavedRecheckJob(opts: { source: "manual" | "cron" }): Promise<SavedRecheckJob> {
  const ids = await listAllSavedCookieIds()
  const job: SavedRecheckJob = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    total: ids.length,
    done: 0,
    alive: 0,
    deleted: 0,
    source: opts.source,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
  }
  if (redisEnabled) {
    await redis.set(IDS_KEY, ids, { ex: JOB_TTL_S })
    await saveJob(job)
  }
  return job
}

// Minimal bounded-concurrency pool.
async function runPool(total: number, limit: number, worker: (i: number) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, total) }, async () => {
    while (true) {
      const i = next++
      if (i >= total) return
      await worker(i)
    }
  })
  await Promise.all(runners)
}

// Processes the next time-budgeted chunk of the active job. Returns whether the
// job still has work left (so the caller can fire a continuation). Safe to call
// repeatedly; if the job is missing/finished it no-ops.
export async function runSavedRecheckChunk(): Promise<{ done: boolean; job: SavedRecheckJob | null }> {
  if (!redisEnabled) return { done: true, job: null }
  const job = await getSavedRecheckJob()
  if (!job || job.status !== "running") return { done: true, job }

  const ids = (await redis.get<string[]>(IDS_KEY)) ?? []
  // No proxy DB anymore: source fresh, Netflix-tested free proxies live so the
  // recheck never dials Netflix from the shared server IP. Cached briefly so the
  // chunked continuations reuse a warm pool instead of re-scraping each time.
  const proxies = await getServerLiveProxies({ limit: 150 })
  // Use the SAME robust checker as the interactive bulk route: per-cookie proxy
  // fail-over on 403/429/timeout + a multi-proxy DEAD_CONFIRMATIONS quorum. This is
  // critical for the automation because it DELETES dead cookies — without the
  // quorum, a single flagged proxy serving a /login challenge for a valid cookie
  // would FALSELY delete a good account. Created once per chunk so learned proxy
  // health is shared across all sub-batches.
  const checkViaProxy = createProxyPoolChecker(proxies)
  const startedChunkAt = Date.now()

  while (job.done < ids.length && Date.now() - startedChunkAt < CHUNK_BUDGET_MS) {
    const slice = ids.slice(job.done, job.done + RECHECK_CONCURRENCY)
    const rows = await loadSavedCookiesByIds(slice)

    // Dead/expired cookies are collected and bulk-deleted once per sub-batch
    // (one DB round-trip) instead of a DELETE per cookie.
    const deadIds: string[] = []

    await runPool(rows.length, RECHECK_CONCURRENCY, async (k) => {
      const entry = rows[k]
      // Stored rows keep the account's ORIGINAL pasted format (RAW / JSON / Netscape)
      // for clean browser export, but the native checker sends its input VERBATIM as
      // the Cookie header. Re-parse to the clean RAW `name=value; …` header first
      // (this Netflix recheck pool is Netflix-only) so a JSON/Netscape-stored cookie
      // verifies correctly instead of coming back permanently inconclusive — which
      // would otherwise leave dead cookies un-purged and the pool stale.
      const header = prepareCookieForCheck(entry.cookie, "netflix").cookie || entry.cookie
      // `job.done + k` drives the round-robin so load keeps moving across exit IPs
      // both within and across chunks. The checker fails over across proxies and
      // confirms dead across the quorum internally.
      const result = await checkViaProxy(header, job.done + k)
      if (result.valid) {
        job.alive++
        return
      }
      // Only delete on a DEFINITIVE dead verdict: clean (no errorCategory) AND
      // confirmed across the DEAD_CONFIRMATIONS quorum. Any errorCategory means a
      // transient/undetermined result (timeout, 429, 5xx, blocked/unconfirmed) — we
      // KEEP those and re-check next cycle so we never delete a good cookie.
      if (!result.errorCategory) deadIds.push(entry.id)
    })

    if (deadIds.length > 0) {
      const removed = await removeSavedCookies(deadIds)
      job.deleted += removed
    }

    job.done += slice.length
    // Persist progress and honor any pause/stop issued mid-chunk.
    const ctl = await saveProgress(job)
    if (ctl !== "running") return { done: true, job: { ...job, status: ctl } }
  }

  if (job.done >= ids.length) {
    job.status = "done"
    job.finishedAt = Date.now()
    await saveJob(job)
    return { done: true, job }
  }

  return { done: false, job }
}

// Builds the absolute URL for a continuation/self-trigger of the recheck route.
export function recheckContinuationUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/admin/saved-cookies/recheck`
}

// Pause a running recheck (keeps progress). Mid-flight chunks observe this and
// bail without firing a continuation.
export async function pauseSavedRecheckJob(): Promise<SavedRecheckJob | null> {
  if (!redisEnabled) return null
  const job = await getSavedRecheckJob()
  if (!job || job.status !== "running") return job
  job.status = "paused"
  await saveJob(job)
  return job
}

// Resume a paused recheck. Returns the job so the caller can fire the next chunk.
export async function resumeSavedRecheckJob(): Promise<SavedRecheckJob | null> {
  if (!redisEnabled) return null
  const job = await getSavedRecheckJob()
  if (!job || (job.status !== "paused" && job.status !== "running")) return job
  job.status = "running"
  await saveJob(job)
  return job
}

// Stop a recheck outright (terminal). Keeps counters reached so far.
export async function stopSavedRecheckJob(): Promise<SavedRecheckJob | null> {
  if (!redisEnabled) return null
  const job = await getSavedRecheckJob()
  if (!job) return null
  if (job.status === "running" || job.status === "paused") {
    job.status = "stopped"
    job.finishedAt = Date.now()
    await saveJob(job)
  }
  return job
}

// Watchdog: re-fire a chunk if a "running" recheck's continuation chain went
// stale. Called from the status poll so a lost chain self-heals.
export async function resumeStaleSavedRecheckJob(origin: string): Promise<void> {
  if (!redisEnabled) return
  const job = await getSavedRecheckJob()
  if (!job || job.status !== "running") return
  if (Date.now() - job.updatedAt <= STALE_RESUME_MS) return
  await saveJob(job) // bumps updatedAt
  await triggerNextRecheckChunk(origin, job.id)
}

// Fire-and-forget the next chunk. Authorized by the unguessable job id (the
// running job acts as a capability token), so it doesn't need the admin cookie.
export async function triggerNextRecheckChunk(origin: string, jobId: string): Promise<void> {
  try {
    await fetch(recheckContinuationUrl(origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-saved-recheck-token": jobId },
      body: JSON.stringify({ _continue: true }),
      cache: "no-store",
    })
  } catch {
    // best-effort; the next manual poll/cron can resume
  }
}
