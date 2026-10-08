"use client"

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Play,
  Pause,
  Square,
  Trash2,
  FileUp,
  ListChecks,
  CircleCheck,
  CircleX,
  CircleAlert,
  Clock,
  Download,
  ChevronDown,
  Copy,
  Check,
  Layers,
  FileText,
  Filter,
  RotateCcw,
  Link2,
  X,
} from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  checkCookieBatch,
  copyText,
  extractCookieSets,
  setLabel,
  buildAccountDetails,
  joinAccountDetails,
  mapChunked,
  cookieToCookieEditorJson,
  cookieForStorage,
  prepareCookieForCheck,
  isAliveResult,
  getCachedResult,
  setCachedResult,
  clearCachedResult,
  normalizePlan,
  type CheckResult,
} from "@/lib/cookie-utils"
import { startLiveProxies, stopLiveProxies, liveProxyCount } from "@/lib/live-proxies"
import { errorLabel, bulkShouldRetry } from "@/lib/check-errors"
import { loadBulkSnapshot, saveBulkSnapshot, clearBulkSnapshot, type PersistedRow } from "@/lib/bulk-persistence"
import { importCookieFiles } from "@/lib/file-import"
import { playComplete, playError } from "@/lib/sound"
import { ResultReport } from "@/components/checker/result-report"
import type { OnAlive } from "@/components/checker/single-checker"
import { parseProxyBlock, type ParsedProxy } from "@/lib/proxies"

type RowStatus = "queued" | "checking" | "retrying" | "alive" | "dead" | "error" | "stopped"

type Row = {
  id: number
  raw: string
  // Cleaned RAW cookie header, prepared once at load time (#5) so we never
  // re-parse the same cookie on every check.
  cookie: string
  label: string
  status: RowStatus
  result?: CheckResult
  error?: string
  // Number of automatic retries already attempted for this row (transient errors).
  attempts?: number
  // OPTIONAL external key (recheck mode): the saved-cookie DB id this row maps
  // back to, so the caller can delete the dead ones after the run completes.
  key?: string
}

// Reported to the caller once a recheck-mode run finishes (not aborted). `dead`
// and `alive` are the external `key`s (saved-cookie ids) of each outcome so the
// Saved tab can prune expired accounts and refresh the list.
export type RecheckSummary = {
  alive: string[]
  dead: string[]
  errored: string[]
  total: number
}

// Cookies sent per POST. Larger batches amortize HTTP round-trip overhead:
// with proxies each cookie in the batch hits a DIFFERENT exit IP server-side,
// so the server fans them all out in parallel (SERVER_CONCURRENCY_PROXY = 30).
// 25 stays within that server-side fan-out, so every cookie in a batch still
// runs in parallel and throughput is unchanged. It also cuts the NUMBER of POSTs
// 2.5x vs 10 — and each POST costs one Redis rate-limiter call plus ~2 Neon
// metric writes (recordChecks), so fewer/larger batches proportionally shrink
// the per-run Redis command + Neon write load that scales with traffic. Lane
// math (lanes = proxyThreads / BATCH_SIZE) auto-compensates, so upstream
// politeness and concurrency are preserved; the only cost is slightly coarser
// AIMD feedback granularity and marginally higher worst-case per-POST latency.
const BATCH_SIZE = 25

// ---- Adaptive concurrency (AIMD congestion control) --------------------
// "Could not reach Netflix." is a TCP/TLS *connect failure*: it appears when a
// single IP opens connections faster than Netflix's edge will accept them. A
// FIXED dispatch rate can't react to that — it just sits at the drop threshold
// and bleeds errors. Instead we treat Netflix like a congested network link and
// run TCP-style AIMD: additively grow the number of in-flight batches while
// healthy, multiplicatively shrink (halve) the instant connects start failing,
// and cool down so the edge recovers. This self-tunes to a sustainable rate, so
// arbitrarily many accounts check consistently instead of collapsing.
const MIN_LIMIT = 1 // never fully stall (half-open probe uses this)
const START_LIMIT = 4 // warm start: fill 4 lanes immediately instead of crawling up from 2
// Concurrency ceiling WITHOUT proxies. A single IP can only sustain a handful
// of simultaneous TLS handshakes to Netflix before its edge starts refusing
// connects. 3 keeps the plateau gentle and steady on a bare connection.
const MAX_LIMIT_NO_PROXY = 3
// Ceiling for a STANDARD (small, < LIVE_SCRAPE_THRESHOLD) run: still proxy-backed
// but it doesn't spin up the high-volume live scrape, so we keep concurrency modest.
const MAX_LIMIT_STANDARD = 20
// Hard ceiling for a TURBO (large, 100+) run. Each lane hits a DIFFERENT exit IP
// so Netflix's per-IP connect limit is irrelevant — the effective ceiling is the
// working-proxy count. 64 lanes × BATCH_SIZE = ~640 concurrent checks, plenty.
const MAX_LIMIT_PROXY = 64

// ---- Strategy threshold + thread-per-proxy model -----------------------
// At/above this cookie count we switch to TURBO: the client runs the continuous
// "scrape + Netflix-test 500 proxies at a time" loop and scales concurrency by how
// many WORKING proxies are live. Below it, a small run just uses the existing
// proxy pool at modest concurrency (no aggressive scraping needed).
const LIVE_SCRAPE_THRESHOLD = 100
// Target simultaneous Netflix checks routed through EACH working proxy. The server
// dials a different proxy per cookie (round-robin), and each proxy dispatcher holds
// ~10 sockets, so this is the real "10 threads for that proxy, 10 for the next…"
// knob the run scales by.
const THREADS_PER_PROXY = 10
// Ramp tuning: 3 consecutive clean batches to grow by 1 lane (was 8) so with
// proxies the window fills in the first ~20 batches instead of ~300+. Single-IP
// runs keep the same safety margin because their ceiling (3) is hit in 1 step.
const INCREASE_AFTER_OK = 3
const INCREASE_HOLD_MS = 4_000 // hold after a drop (ms) before probing upward again

// Skip-and-come-back-later policy. A cookie that hits a retryable failure is
// retried a couple of times IN PLACE (sharing the live congestion window), and
// if it still fails it's SET ASIDE ("deferred") instead of being hammered. Once
// the main run drains, deferred cookies are retried in fresh PASSES, each after a
// short breather so the proxy pool / Netflix can recover. This stops a struggling
// cookie from burning the whole run's headroom and leaves it for a calmer moment.
const QUICK_RETRIES = 2 // in-window retries before a cookie is deferred
// How many deferred sweeps before giving up for good. Set generously because the
// background scraper keeps feeding FRESH proxies between passes, so a cookie that
// errored on a blocked proxy gets several more shots on clean exit IPs — the run
// should finish with effectively no transient errors left.
// Budget of UNPRODUCTIVE passes (passes that brought NO newly-scraped proxies)
// before giving up. A pass that gains fresh exit IPs is a genuinely new attempt and
// resets this budget, so a run keeps retrying stragglers as long as the scraper is
// still feeding working proxies — it only gives up once the pool truly stops growing.
const MAX_PASSES = 8
// Absolute safety cap on total deferred passes so that, even with proxies arriving
// forever, the run can never loop endlessly on permanently-unreachable cookies.
const HARD_PASS_CAP = 40
// Short breather before each deferred pass. Kept brief so errored cookies come
// back around quickly (fresh proxies are continuously scraped in the background)
// rather than the run feeling stuck waiting on stragglers.
const PASS_RECOVERY_MS = 2_500

// Backoff + circuit-breaker tuning. Wider window + higher trip ratio so the
// breaker opens only on a genuine sustained failure (not a couple of blips),
// and a shorter full-stop so recovery doesn't look like a long freeze.
const BACKOFF_MS = 3_000 // base cooldown after a transient batch
const BREAKER_WINDOW = 16 // outcomes tracked in the sliding error-rate window
const BREAKER_MIN_SAMPLES = 8 // don't trip the breaker on a tiny sample
const BREAKER_ERROR_RATIO = 0.5 // >50% failures in the window ⇒ open the breaker
const BREAKER_COOLDOWN_MS = 6_000 // full pause when the breaker opens
// 30ms stagger: still prevents a TLS thundering-herd on cold start (50 lanes
// would otherwise all dial Netflix simultaneously), but 6.6× faster window-fill
// than 200ms — 64 lanes fill in ~2s instead of ~13s.
const DISPATCH_STAGGER_MS = 30

// HEARTBEAT: re-evaluate the scheduler on a steady cadence regardless of in-flight
// batches. Without this, when every lane is busy the pump only runs again once a
// batch finishes (.then → pump) — so a freshly-scraped working proxy couldn't open
// a new lane until an existing batch completed (tens of seconds later). The ticker
// makes the run notice a new proxy and dispatch against it within ~150ms. Cheap:
// pump() is idempotent and just returns when there's nothing to do.
const HEARTBEAT_MS = 150

// CONTINUOUS-RETRY cap. A cookie that hits a retryable failure is pushed straight
// back into the live queue to be re-checked on the next FRESH proxy (the proxy-wait
// gate parks it until a working proxy exists), instead of being parked in a deferred
// pass. This per-entry cap guarantees the run still terminates if a cookie is
// permanently unreachable even though fresh proxies keep arriving. Generous because
// each re-check lands on a newly-scraped exit IP, so genuine accounts resolve well
// within it and only truly dead cookies ever exhaust it.
const MAX_ENTRY_RETRIES = 20

// Safety valve: if the live pool stays COMPLETELY empty for this long while work is
// still queued (the scraper has stopped finding any working proxy at all), stop
// waiting and finalize the stragglers as errors so the run always terminates rather
// than sitting on "Waiting for a working proxy…" forever. Generous because the
// background scraper normally refills within seconds; only a total proxy drought
// trips this.
const NO_PROXY_GIVEUP_MS = 90_000

// How quickly a deferred straggler is retried once a FRESH working proxy is
// available. The whole point of deferring is to wait for a new exit IP; the moment
// the pool grows we want to re-dial those rows almost immediately (not sit on the
// slow inter-pass recovery delay), because a new working proxy is exactly what makes
// the previously-failing row succeed. This is what turns an "almost done, frozen"
// tail into a run that finishes cleanly without erroring rows out.
const FRESH_PROXY_RETRY_MS = 150

// Maps the WORKING-proxy count to a concurrency ceiling. Every proxy gets
// THREADS_PER_PROXY concurrent lanes (server round-robins across IPs). Updated
// both from batch responses AND proactively each pump tick from the live client
// count so a freshly-scraped proxy raises the ceiling immediately without waiting
// for the next batch to complete.
function ceilingFor(proxyCount: number, turbo: boolean): number {
  if (!proxyCount || proxyCount <= 0) return MAX_LIMIT_NO_PROXY
  const lanes = Math.round((proxyCount * THREADS_PER_PROXY) / BATCH_SIZE)
  const cap = turbo ? MAX_LIMIT_PROXY : MAX_LIMIT_STANDARD
  return Math.min(cap, Math.max(START_LIMIT + 4, lanes))
}

export function BulkChecker({
  onAlive,
  storageKey = "public",
  isAdmin = false,
  autoProxyScrapeEnabled = true,
  recheckMode = false,
  seedRows,
  seedSignal = 0,
  onRunComplete,
  onRunStateChange,
  service = "netflix",
  linksOnly = false,
}: {
  onAlive?: OnAlive
  storageKey?: string
  // Which streaming service this checker validates against. Threaded into every
  // /api/check call so the same proxy pipeline targets Netflix, Amazon Prime, or
  // Crunchyroll.
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  // When true, cookie copy actions are hidden from result reports.
  linksOnly?: boolean
  // ADMIN runs under LIVE_SCRAPE_THRESHOLD check DIRECTLY from the server (no proxy
  // scrape, no wait). Public runs — and admin runs at/above the threshold — ALWAYS
  // go through live-scraped proxies, waiting for working ones before starting.
  isAdmin?: boolean
  // Current administrator-controlled public proxy policy. Admin checkers always
  // retain automatic scraping; this flag is shown clearly in the public UI.
  autoProxyScrapeEnabled?: boolean
  // RECHECK MODE: the Saved tab embeds this same fast engine to re-validate stored
  // accounts. It hides the paste/upload inputs, seeds rows from `seedRows`, and is
  // driven by `seedSignal` (bumping it (re)loads the seed and auto-starts a run).
  recheckMode?: boolean
  // Saved accounts to recheck, each carrying its DB id as `key` so dead ones can be
  // mapped back and deleted after the run.
  seedRows?: { key: string; cookie: string; label?: string }[]
  // Bump this number to (re)seed from `seedRows` and immediately start a recheck.
  seedSignal?: number
  // Fired when a recheck run finishes (not aborted) with the per-account outcomes.
  onRunComplete?: (summary: RecheckSummary) => void
  // Fired whenever the live run state changes, so an external surface (the admin
  // global status pill) can mirror progress from another tab. Optional — the
  // public page doesn't pass it.
  onRunStateChange?: (state: {
    running: boolean
    paused: boolean
    preparing: boolean
    total: number
    done: number
    alive: number
    dead: number
    error: number
    progress: number
  }) => void
}) {
  const [text, setText] = useState("")
  const [running, setRunning] = useState(false)
  // True while we're scraping + Netflix-testing the first working proxies before a
  // proxy-backed run actually begins (so the run never dials from a stale/empty pool).
  const [preparing, setPreparing] = useState(false)
  // `paused` is a run-level state distinct from `running`: a paused run keeps its
  // rows/results but has no work in flight. It's set by the user (Pause button)
  // or automatically when a run is interrupted by a page reload.
  const [paused, setPaused] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Opt-in auth-link minting (OFF by default — costs an extra upstream request
  // per alive cookie). A ref mirrors it so the long-lived run loop always reads
  // the current value without being re-created on toggle.
  const [includeLinks, setIncludeLinks] = useState(false)
  const [manualProxyText, setManualProxyText] = useState("")
  const [manualProxies, setManualProxies] = useState<ParsedProxy[]>([])
  const proxyStorageKey = `cookies-mo:manual-proxies:${storageKey}:${service}`
  const [proxyStorageLoaded, setProxyStorageLoaded] = useState(false)

  // Keep manual proxy lists in this browser, separately for public/admin and each
  // service checker. Storage is best-effort so private browsing or blocked storage
  // never prevents the checker from working.
  useEffect(() => {
    if (recheckMode || proxyStorageLoaded) return
    try {
      const saved = window.localStorage.getItem(proxyStorageKey)
      if (saved !== null) {
        setManualProxyText(saved)
        setManualProxies(parseProxyBlock(saved))
      }
    } catch {
      // Ignore unavailable browser storage.
    } finally {
      setProxyStorageLoaded(true)
    }
  }, [proxyStorageKey, proxyStorageLoaded, recheckMode])

  useEffect(() => {
    if (recheckMode || !proxyStorageLoaded) return
    try {
      if (manualProxyText.trim()) window.localStorage.setItem(proxyStorageKey, manualProxyText)
      else window.localStorage.removeItem(proxyStorageKey)
    } catch {
      // Ignore unavailable browser storage.
    }
  }, [manualProxyText, proxyStorageKey, recheckMode])

  // Auto-login links (nftoken) are Netflix-only; never mint/request them for
  // Prime or Crunchyroll (the toggle is also hidden for those services below).
  const isNetflix = service === "netflix"
  const includeLinksRef = useRef(includeLinks)
  includeLinksRef.current = isNetflix && includeLinks
  const [statusFilter, setStatusFilter] = useState("all")
  const [planFilter, setPlanFilter] = useState("all")
  const [countryFilter, setCountryFilter] = useState("all")
  const [announcement, setAnnouncement] = useState("")
  // Real-time elapsed clock for the active run. `runStartRef` is the wall-clock
  // start; `elapsedMs` ticks while running and freezes at the final duration when
  // the run ends so the total stays visible.
  const [elapsedMs, setElapsedMs] = useState(0)
  const runStartRef = useRef<number | null>(null)
  // True once a (non-aborted, non-recheck) run has finished — used to swap the
  // primary action to "Recheck dead cookies" and to surface the results modal.
  const [hasCompleted, setHasCompleted] = useState(false)
  // Controls the post-run results modal (close-button only — see ResultsModal).
  const [resultsOpen, setResultsOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const idRef = useRef(0)
  // Mirrors of run state for use inside event handlers / cleanup closures that
  // would otherwise capture a stale value.
  const runningRef = useRef(false)
  const pausedRef = useRef(false)
  const restoredRef = useRef(false)

  // --- Ref-based row store so React memo() actually bails out ----------------
  // The core problem: with useState<Row[]>, every flush() call replaces the
  // entire array, so every ResultRow re-renders on every animation frame even
  // though only ~24 rows changed. With 1800+ rows that saturates the main
  // thread and freezes all animations.
  //
  // Solution: store rows in a ref Map<id,Row> + a ref ordered list. The single
  // useState `rowVersion` counter triggers a container re-render (once per RAF
  // frame), but ResultRow receives only its stable row id and reads its data
  // from the map ref via a getRow callback. memo() then skips rows whose map
  // entry object hasn't changed.
  const rowMapRef = useRef<Map<number, Row>>(new Map()) // id → row (mutable, no re-render)
  const rowIdsRef = useRef<number[]>([]) // insertion order
  const [rowVersion, setRowVersion] = useState(0) // bump to trigger ONE re-render
  const bumpVersion = useCallback(() => setRowVersion((v) => v + 1), [])

  // Derive the plain array synchronously from refs (cheap — just reads the map).
  // This is used by export helpers and counts. We depend on rowVersion so it
  // recalculates after each flush.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => rowIdsRef.current.map((id) => rowMapRef.current.get(id)!), [rowVersion])

  // Helpers that update the map directly (no setState). The functional form reads
  // the CURRENT ref state (not the `rows` memo, which is stale until the next
  // render) so back-to-back updates in a single tick compose correctly — e.g. the
  // recheck seed does setRows(seeded) then runChecks() synchronously resets the
  // same rows; reading the memo there would see the pre-seed empty array and wipe
  // the freshly-seeded rows, leaving progress stuck at 0/0.
  function setRows(updater: Row[] | ((prev: Row[]) => Row[])) {
    const prev = rowIdsRef.current.map((id) => rowMapRef.current.get(id)!).filter(Boolean)
    const next = typeof updater === "function" ? updater(prev) : updater
    rowMapRef.current = new Map(next.map((r) => [r.id, r]))
    rowIdsRef.current = next.map((r) => r.id)
    bumpVersion()
  }

  // Buffer per-row patches and flush them together on a frame — ONE re-render
  // per frame regardless of how many rows updated.
  const pendingRef = useRef<Map<number, Partial<Row>>>(new Map())
  const rafRef = useRef<number | null>(null)

  // Parsing the paste box on every keystroke is expensive on big inputs; defer it
  // so typing stays responsive and the count catches up when the input settles.
  const deferredText = useDeferredValue(text)
  const pastedCount = useMemo(() => extractCookieSets(deferredText, service).length, [deferredText, service])

  // Available plan / country values pulled from alive results, for the filters.
  // Plans are normalized to canonical English tiers so the dropdown never shows
  // foreign names ("DASAR") or fragmented "(Extra Member)" duplicates.
  const planOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => normalizePlan(r.result?.plan)).filter((v): v is string => !!v))).sort(),
    [rows],
  )
  const countryOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.result?.countryCode).filter((v): v is string => !!v))).sort(),
    [rows],
  )

  // Rows keep their original 1-based number even after filtering.
  const visibleRows = useMemo(
    () =>
      rows
        .map((row, i) => ({ row, index: i + 1 }))
        .filter(
          ({ row }) =>
            (statusFilter === "all" || row.status === statusFilter) &&
            (planFilter === "all" || normalizePlan(row.result?.plan) === planFilter) &&
            (countryFilter === "all" || row.result?.countryCode === countryFilter),
        ),
    [rows, statusFilter, planFilter, countryFilter],
  )

  const filtersActive = statusFilter !== "all" || planFilter !== "all" || countryFilter !== "all"

  const counts = useMemo(() => {
    const c = { total: rows.length, alive: 0, dead: 0, error: 0, done: 0 }
    for (const r of rows) {
      if (r.status === "alive") c.alive++
      else if (r.status === "dead") c.dead++
      else if (r.status === "error") c.error++
      if (["alive", "dead", "error"].includes(r.status)) c.done++
    }
    return c
  }, [rows])

  // Aggregate breakdowns for the results modal (no per-row table — just stats).
  // Plans, countries and extra-member share are computed over the ALIVE rows,
  // since those are the only ones carrying account metadata.
  const stats = useMemo(() => {
    const plans = new Map<string, number>()
    const countries = new Map<string, number>()
    let extraMembers = 0
    let withEmail = 0
    for (const r of rows) {
      if (r.status !== "alive" || !r.result) continue
      const plan = normalizePlan(r.result.plan) || "Unknown"
      plans.set(plan, (plans.get(plan) ?? 0) + 1)
      const cc = r.result.countryCode || "Unknown"
      countries.set(cc, (countries.get(cc) ?? 0) + 1)
      if (r.result.extraMember) extraMembers++
      if (r.result.email) withEmail++
    }
    const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1]
    return {
      plans: [...plans.entries()].sort(byCount),
      countries: [...countries.entries()].sort(byCount),
      extraMembers,
      withEmail,
    }
  }, [rows])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Tick the elapsed clock ~5×/sec while a run (or its proxy pre-flight) is active.
  // When it stops, the interval is cleared and elapsedMs keeps its last value.
  useEffect(() => {
    if (!running && !preparing) return
    const id = window.setInterval(() => {
      if (runStartRef.current != null) setElapsedMs(Date.now() - runStartRef.current)
    }, 200)
    return () => window.clearInterval(id)
  }, [running, preparing])

  // Lock background scroll while the results modal is open.
  useEffect(() => {
    if (!resultsOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [resultsOpen])

  // Keep refs in sync so unload/cleanup handlers see the latest run state.
  useEffect(() => {
    runningRef.current = running
    pausedRef.current = paused
  }, [running, paused])

  // ----- Refresh-proof persistence ----------------------------------------
  // Build a compact snapshot straight from the refs (always current).
  const buildSnapshot = useCallback(
    () => ({
      v: 1 as const,
      savedAt: Date.now(),
      wasRunning: runningRef.current || pausedRef.current,
      rows: rowIdsRef.current.reduce<PersistedRow[]>((acc, id) => {
        const r = rowMapRef.current.get(id)
        if (r) acc.push({ r: r.raw, s: r.status, e: r.error, d: r.result })
        return acc
      }, []),
    }),
    [],
  )

  const persistNow = useCallback(() => {
    // Recheck mode never persists — its rows are a transient view of the saved list.
    if (recheckMode) return
    if (rowIdsRef.current.length === 0) {
      clearBulkSnapshot(storageKey)
      return
    }
    saveBulkSnapshot(storageKey, buildSnapshot())
  }, [storageKey, buildSnapshot, recheckMode])

  // Restore once on mount. A run that was active at save time comes back PAUSED
  // (never auto-resumed) so the user explicitly continues — matching the
  // "just pause on refresh" behavior.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    // Recheck mode is seeded fresh from the saved list each time — never restore a
    // stale localStorage snapshot (it would resurrect deleted/old accounts).
    if (recheckMode) return
    const snap = loadBulkSnapshot(storageKey)
    if (!snap || snap.rows.length === 0) return
    const restored: Row[] = snap.rows.map((p) => {
      // Anything that was mid-flight becomes queued so it can be resumed.
      const s = p.s === "checking" || p.s === "retrying" || p.s === "stopped" ? "queued" : (p.s as RowStatus)
      return {
        id: idRef.current++,
        raw: p.r,
        cookie: prepareCookieForCheck(p.r, service).cookie,
        label: setLabel(p.r),
        status: s,
        error: p.e,
        result: p.d,
      }
    })
    rowMapRef.current = new Map(restored.map((r) => [r.id, r]))
    rowIdsRef.current = restored.map((r) => r.id)
    bumpVersion()
    const pending = restored.some((r) => r.status === "queued")
    if (snap.wasRunning && pending) {
      setPaused(true)
      setAnnouncement("Restored after reload — paused. Click Resume to continue.")
      toast.info("Restored your previous run — paused. Click Resume to continue.")
    } else {
      toast.success(`Restored ${restored.length} previous result(s).`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced save whenever rows or run state change (kept cheap for big lists).
  useEffect(() => {
    if (!restoredRef.current) return
    const t = setTimeout(persistNow, 1_200)
    return () => clearTimeout(t)
  }, [rowVersion, running, paused, persistNow])

  // Save immediately on tab-hide and before unload so a refresh never loses work.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") persistNow()
    }
    window.addEventListener("beforeunload", persistNow)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("beforeunload", persistNow)
      document.removeEventListener("visibilitychange", onHide)
      // On unmount (e.g. navigating away from the checker), stop in-flight work
      // and persist a snapshot so returning restores it in a paused state.
      abortRef.current?.abort()
      persistNow()
    }
  }, [persistNow])

  function makeRows(sets: string[]): Row[] {
    return sets.map((raw) => ({
      id: idRef.current++,
      raw,
      // Parse + clean each cookie a single time, here at load (#5). Service-aware so
      // Prime sends its FULL session set (most accurate) while Netflix/Crunchyroll
      // send their lean auth slice.
      cookie: prepareCookieForCheck(raw, service).cookie,
      label: setLabel(raw),
      status: "queued" as RowStatus,
    }))
  }

  // ----- Recheck seeding -------------------------------------------------------
  // Driven by `seedSignal`: each bump (re)builds the row set from the saved list
  // (carrying each account's DB id as `key`) and immediately starts a fast run via
  // the SAME engine the public bulk checker uses. `onRunComplete` (fired at the end
  // of runChecks) then hands the dead ids back so the Saved tab can prune them.
  const lastSeedRef = useRef(0)
  useEffect(() => {
    if (!recheckMode || seedSignal <= 0 || seedSignal === lastSeedRef.current) return
    lastSeedRef.current = seedSignal
    const items = seedRows ?? []
    if (items.length === 0) {
      toast.info("No saved accounts to recheck.")
      return
    }
    if (runningRef.current) {
      toast.info("A recheck is already running.")
      return
    }
    abortRef.current?.abort()
    const seeded: Row[] = items.map((it) => ({
      id: idRef.current++,
      raw: it.cookie,
      cookie: prepareCookieForCheck(it.cookie, service).cookie,
      label: it.label ?? setLabel(it.cookie),
      status: "queued" as RowStatus,
      key: it.key,
    }))
    setRows(seeded)
    void runChecks(seeded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSignal, recheckMode])

  function loadFromPaste() {
    const sets = extractCookieSets(text, service)
    if (sets.length === 0) {
      toast.error("No cookies detected in the pasted text.")
      return
    }
    setRows(makeRows(sets))
    toast.success(`Loaded ${sets.length} cookie${sets.length === 1 ? "" : "s"}.`)
  }

  async function handleProxyFile(fileList: FileList | File[] | null) {
    const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    try {
      const text = (await Promise.all(files.map((file) => file.text()))).join("\n")
      const combined = [manualProxyText, text].filter(Boolean).join("\n")
      const parsed = parseProxyBlock(combined)
      setManualProxyText(combined)
      setManualProxies(parsed)
      toast.success(`Loaded ${parsed.length} unique pro${parsed.length === 1 ? "xy" : "xies"}.`)
    } catch {
      toast.error("Couldn&apos;t read the proxy file.")
    }
  }

  async function handleFiles(fileList: FileList | File[] | null) {
  const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    setLoadingFiles(true)
    try {
      const { sets, fileCount, skipped } = await importCookieFiles(files, service)
      if (sets.length === 0) {
        toast.error("No cookies found in the uploaded file(s).")
        return
      }
      setRows(makeRows(sets))
      toast.success(`Loaded ${sets.length} cookies from ${fileCount} file(s).`)
      if (skipped.length > 0) toast.info(`Skipped ${skipped.length} item(s) with no cookies.`)
    } catch {
      toast.error("Couldn't process the uploaded file(s).")
    } finally {
      setLoadingFiles(false)
    }
  }

  // Runs checks for the given target rows. Shared by "check all" and
  // "retry failed only" so both get the cache, circuit breaker, and backoff.
  // EPHEMERAL PROXIES: while a run is active, continuously scrape + reachability-
  // test free proxies in THIS browser session (lib/live-proxies) and keep only the
  // fastest survivors in memory — nothing is ever written to the database. Each
  // /api/check call (in checkCookieBatch) sends the fastest-first slice, so the
  // server dials this session's own freshly-verified exit IPs. Free proxies die in
  // minutes, so live scraping is both faster and more accurate than a stored pool.
  const startReplenish = useCallback((turbo: boolean) => startLiveProxies({ turbo }), [])
  const stopReplenish = useCallback(() => stopLiveProxies(), [])
  // Mirrors whether the active run is in TURBO mode (100+ cookies) so the long-
  // lived scheduler closure always reads the current value when sizing the window.
  const turboRef = useRef(false)
  // Mirrors whether THIS run routes through live proxies (true) or checks directly
  // (admin small runs). Read by every batch call so it attaches proxies or not.
  const useProxiesRef = useRef(true)
  const manualProxiesRef = useRef<ParsedProxy[]>([])
  manualProxiesRef.current = manualProxies
  const manualMode = manualProxies.length > 0
  const proxyCountNow = () => (manualProxiesRef.current.length > 0 ? manualProxiesRef.current.length : liveProxyCount())

  // Safety net: stop the loop if the component unmounts mid-run.
  useEffect(() => stopReplenish, [stopReplenish])

  // `bypassCache` forces a genuine network re-check of every target cookie instead
  // of instantly reusing a recently-cached verdict. Essential for "Recheck dead":
  // a dead cookie was just checked, so its "dead" result is still in the 5-min
  // cache — without this the recheck would re-mark everything dead in milliseconds
  // and "complete" without ever dialing a fresh proxy.
  async function runChecks(targetRows: Row[], opts?: { bypassCache?: boolean }) {
    if (targetRows.length === 0 || running) return
    const bypassCache = opts?.bypassCache ?? false
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setPaused(false)
    // Start (and reset) the real-time elapsed clock for this run.
    runStartRef.current = Date.now()
    setElapsedMs(0)
    // A fresh run supersedes the previous completion state. NOTE: we intentionally
    // do NOT close the results modal here — a "Recheck dead" launched from inside
    // the modal keeps it open so its stats update live as dead cookies are retested.
    setHasCompleted(false)

    // ---- ROUTING POLICY -----------------------------------------------------
    // ALL bulk runs route through live-scraped proxies — public AND admin, including
    // the Saved-tab recheck and automation rechecks — so we NEVER dial Netflix from
    // the shared server IP at volume (which would get the IP flagged/rate-limited).
    // Only the SINGLE checker and the free-account / public-reward checks run direct
    // (those are one-request-at-a-time and handled elsewhere). TURBO = a proxy run
    // large enough (>= LIVE_SCRAPE_THRESHOLD) to want the continuous high-volume
    // scrape + proxy-count-scaled concurrency.
    const isLarge = targetRows.length >= LIVE_SCRAPE_THRESHOLD
    const useProxies = true
    const useManualProxies = !isAdmin && !recheckMode && manualProxiesRef.current.length > 0
    const turbo = isLarge
    useProxiesRef.current = useProxies
    turboRef.current = turbo

    const targetIds = new Set(targetRows.map((r) => r.id))
    setRows((prev) =>
      prev.map((r) => (targetIds.has(r.id) ? { ...r, status: "queued", result: undefined, error: undefined } : r)),
    )

    // PROXY PRE-FLIGHT: when this run routes through proxies, start the continuous
    // scrape + Netflix-test loop and begin THE MOMENT the first working proxies are
    // ready — we only need a tiny seed (the server prefers proven-good proxies and
    // fails over fast), and the background scrape keeps the pool growing while the
    // run proceeds. This avoids a long up-front wait while still never dialing from
    // an empty pool. Admin direct runs skip this entirely and start immediately.
    if (useProxies && !useManualProxies) {
      startReplenish(turbo)
      setPreparing(true)
      setAnnouncement("Scraping and testing proxies…")
      // START AT THE FIRST GOOD PROXY: as soon as a SINGLE working proxy has been
      // scraped + Netflix-tested, begin checking — don't wait for a batch to pile
      // up. The background scrape keeps streaming fresh exit IPs and the run scales
      // its concurrency up as more arrive (see the pump's live ceiling logic). Poll
      // at a fine granularity so we notice that first proxy within ~120ms.
      const minReady = 1
      const waitDeadline = Date.now() + 45_000
      while (proxyCountNow() < minReady && Date.now() < waitDeadline && !ac.signal.aborted) {
        setAnnouncement(`Preparing proxies… ${proxyCountNow()} ready`)
        await new Promise((r) => setTimeout(r, 120))
      }
      setPreparing(false)
      if (ac.signal.aborted) {
        setRunning(false)
        stopReplenish()
        return
      }
    }

    const flush = () => {
      rafRef.current = null
      const patches = pendingRef.current
      if (patches.size === 0) return
      pendingRef.current = new Map()
      // Patch the map entries directly — only changed row objects are replaced,
      // so ResultRow memo() skips every unchanged row.
      for (const [id, patch] of patches) {
        const existing = rowMapRef.current.get(id)
        if (existing) rowMapRef.current.set(id, { ...existing, ...patch })
      }
      bumpVersion() // one re-render for the whole container
    }
    const setStatus = (id: number, patch: Partial<Row>) => {
      const existing = pendingRef.current.get(id)
      pendingRef.current.set(id, existing ? { ...existing, ...patch } : patch)
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush)
    }
    const setStatusMany = (ids: number[], patch: Partial<Row>) => {
      for (const id of ids) setStatus(id, patch)
    }

    // Snapshot of all current rows straight from the refs (the outer `rows` memo
    // is stale inside this long-running async function).
    const currentRows = () => rowIdsRef.current.map((id) => rowMapRef.current.get(id)).filter(Boolean) as Row[]

    const announce = () => {
      const rs = currentRows()
      const done = rs.filter((r) => r.status === "alive" || r.status === "dead" || r.status === "error").length
      setAnnouncement(`Checked ${done} of ${rs.length} cookies.`)
    }

    // ---- De-dupe + cache, then build the initial work queue ----------------
    // Identical cookies are checked once and their verdict fanned out to every
    // row that shares them; recently-cached verdicts are applied instantly.
    const cookieToRowIds = new Map<string, number[]>()
    for (const r of targetRows) {
      if (!r.cookie) {
        setStatus(r.id, { status: "error", error: "No valid cookies found." })
        continue
      }
      const ids = cookieToRowIds.get(r.cookie)
      if (ids) ids.push(r.id)
      else cookieToRowIds.set(r.cookie, [r.id])
    }
    const pendingCookies: string[] = []
    for (const [cookie, ids] of cookieToRowIds) {
      // On a forced recheck, ignore (and drop) any cached verdict so the cookie is
      // truly re-dialed; otherwise reuse a fresh cached result to save a round-trip.
      if (bypassCache) {
        clearCachedResult(cookie)
        pendingCookies.push(cookie)
        continue
      }
      const cached = getCachedResult(cookie)
      if (cached) setStatusMany(ids, { status: isAliveResult(cached) ? "alive" : "dead", result: cached })
      else pendingCookies.push(cookie)
    }

    // A task = a batch of cookie entries plus the attempt number. Tasks are
    // pushed back onto the queue on retryable failure, so the SAME adaptive
    // window governs first tries and retries alike.
    type Entry = { cookie: string; ids: number[]; lastError?: string; lastResult?: CheckResult; retries?: number }
    type Task = { entries: Entry[]; attempt: number }
    const queue: Task[] = []
    for (let i = 0; i < pendingCookies.length; i += BATCH_SIZE) {
      const slice = pendingCookies.slice(i, i + BATCH_SIZE)
      queue.push({ entries: slice.map((c) => ({ cookie: c, ids: cookieToRowIds.get(c)! })), attempt: 0 })
    }

    // Cookies set aside after their quick in-window retries; retried in later
    // passes once the main queue drains. `pass` counts deferred sweeps so we give
    // up after MAX_PASSES instead of looping forever on permanently-bad cookies.
    let deferred: Entry[] = []
    // Timestamp (ms) when the live proxy pool first became empty while work was still
    // queued; 0 means "not currently empty". Drives the NO_PROXY_GIVEUP_MS safety valve.
    let emptyPoolSince = 0
    let pass = 0
    // Only passes that bring NO newly-scraped proxies count toward MAX_PASSES; a
    // pass that gains fresh exit IPs resets this so we keep retrying on new proxies.
    let unproductivePasses = 0
    let lastPassProxyCount = 0

    // ---- AIMD controller + circuit breaker --------------------------------
    // `ceiling` is dynamic: it starts at the safe single-IP value and is raised
    // once the server reports a configured proxy pool (load is then spread across
    // many IPs). `holdUntil` is the anti-sawtooth: after any drop we refuse to
    // grow the limit for a while, so it settles on a steady plateau instead of
    // overshooting → freezing → retry-storming.
    const ctrl = {
      limit: START_LIMIT,
      ceiling: MAX_LIMIT_NO_PROXY,
      inFlight: 0,
      okStreak: 0,
      cooldownUntil: 0,
      holdUntil: 0,
      window: [] as boolean[], // recent outcomes: true = clean, false = transient
    }
    // Fold one batch outcome into the controller. A transient failure halves the
    // limit, arms a cooldown, and holds growth; a high error ratio trips the
    // breaker (full pause, drop to MIN_LIMIT). Clean batches grow the limit
    // slowly — and only when the recent window is fully clean and the post-drop
    // hold has elapsed.
    const recordOutcome = (transient: boolean, retryAfterMs?: number) => {
      ctrl.window.push(!transient)
      if (ctrl.window.length > BREAKER_WINDOW) ctrl.window.shift()
      const now = Date.now()
      // PROXY RUNS DON'T BACK OFF. Every lane dials a DIFFERENT exit IP, so a
      // transient failure means "that proxy was bad", NOT "Netflix is throttling
      // our IP". Halving the window, arming cooldowns, or opening the breaker would
      // stall the whole run on a few bad proxies — which is exactly what made rows
      // sit in RETRYING. Instead we keep the window wide open and let the failed
      // cookie immediately re-queue onto the next FRESH proxy (see requeue). The
      // proxy-wait gate already prevents dialing from the bare server IP.
      if (transient && useProxiesRef.current) {
        ctrl.okStreak = 0
        return
      }
      if (transient) {
        ctrl.okStreak = 0
        ctrl.limit = Math.max(MIN_LIMIT, Math.floor(ctrl.limit / 2))
        ctrl.holdUntil = now + INCREASE_HOLD_MS
        const errors = ctrl.window.filter((ok) => !ok).length
        const ratio = errors / ctrl.window.length
        const base = retryAfterMs ?? BACKOFF_MS
        if (ctrl.window.length >= BREAKER_MIN_SAMPLES && ratio >= BREAKER_ERROR_RATIO) {
          // Breaker OPEN: stop the world briefly so Netflix's edge recovers, then
          // resume half-open at MIN_LIMIT and ramp from there.
          ctrl.limit = MIN_LIMIT
          ctrl.cooldownUntil = now + Math.max(base, BREAKER_COOLDOWN_MS)
          ctrl.window = []
          setAnnouncement("Netflix is throttling — pausing briefly to recover…")
        } else {
          ctrl.cooldownUntil = Math.max(ctrl.cooldownUntil, now + base)
        }
      } else {
        ctrl.okStreak++
        const windowClean = ctrl.window.every((ok) => ok)
        if (ctrl.okStreak >= INCREASE_AFTER_OK && now >= ctrl.holdUntil && windowClean && ctrl.limit < ctrl.ceiling) {
          ctrl.okStreak = 0
          // When far below a proxy-backed ceiling, grow by multiple lanes at once
          // so a large pool reaches full utilization quickly instead of taking
          // hundreds of batches. Near the ceiling (or on a single IP) stay at +1
          // to avoid overshoot.
          const gap = ctrl.ceiling - ctrl.limit
          const step = ctrl.ceiling > MAX_LIMIT_NO_PROXY && gap > 8 ? Math.max(2, Math.floor(gap / 4)) : 1
          ctrl.limit = Math.min(ctrl.ceiling, ctrl.limit + step)
        }
      }
    }

    // Handle retryable entries: CONTINUOUS RE-QUEUE. The instant a cookie hits a
    // retryable failure it goes straight back into the LIVE queue so it is re-checked
    // on the next FRESH proxy — we never park it in a deferred pass and we never make
    // it wait out a long recovery cooldown. The proxy-wait gate in the pump holds the
    // tick until a working proxy exists, so a re-queued cookie naturally waits for a
    // good proxy and then bulk-checks again. A per-entry attempt cap (MAX_ENTRY_RETRIES)
    // guarantees the run still terminates if a cookie is permanently unreachable, even
    // though the scraper keeps feeding fresh exit IPs until the very end of the run.
    const requeue = (attempt: number, entries: Entry[]) => {
      if (entries.length === 0) return
      const stillRetryable: Entry[] = []
      for (const e of entries) {
        e.retries = (e.retries ?? 0) + 1
        if (e.retries <= MAX_ENTRY_RETRIES) {
          setStatusMany(e.ids, { status: "retrying" })
          stillRetryable.push(e)
        } else {
          // Exhausted every fresh-proxy shot — finalize so the run can complete.
          setStatusMany(e.ids, {
            status: "error",
            error: e.lastError ?? "Could not reach Netflix.",
            result: e.lastResult,
          })
        }
      }
      if (stillRetryable.length === 0) return
      // First couple of re-tries jump to the FRONT so a freshly-failed cookie is
      // re-dialed on a new proxy ahead of the backlog; later re-tries go to the BACK
      // so they keep cycling onto ever-newer scraped proxies without starving cookies
      // that haven't been tried yet.
      const next = attempt + 1
      if (next < QUICK_RETRIES) queue.unshift({ entries: stillRetryable, attempt: next })
      else queue.push({ entries: stillRetryable, attempt: next })
    }

    // Run one attempt of one batch. Applies definitive verdicts immediately and
    // returns whether the batch saw a true congestion event (drives the AIMD
    // controller). Proxy-level failures that were resolved server-side by failing
    // over to a fresh proxy are NOT transient from the controller's perspective —
    // they should NOT shrink the window or arm a cooldown.
    const dispatchTask = async (task: Task): Promise<{ transient: boolean; retryAfterMs?: number }> => {
      const cookies = task.entries.map((e) => e.cookie)
      for (const e of task.entries) setStatusMany(e.ids, { status: task.attempt > 0 ? "retrying" : "checking" })

      // Per-cookie verdicts are applied LIVE via the streaming onResult callback
      // below, so a row flips to alive/dead/retry the instant its verdict arrives —
      // a slow cookie no longer holds up its batch-mates. These collectors are
      // populated as results stream in, then drained after the batch completes.
      const aliveBatch: { cookie: string; result: CheckResult }[] = []
      const retryEntries: Entry[] = []
      const handled = new Set<number>()
      let sawTransient = false
      // Entries that should be retried after a WHOLE-BATCH failure (timeout / 429 /
      // network): those that never received a streamed verdict, PLUS those that
      // streamed a retryable error (collected in retryEntries). Entries already
      // resolved to a FINAL alive/dead verdict are excluded — they must never be
      // reverted to "retrying" (that's what made a finished run look unfinished and
      // progress go backwards). retryEntries and the unhandled set are disjoint.
      const pendingForRetry = (): Entry[] => {
        const unhandled = task.entries.filter((_, idx) => !handled.has(idx))
        return retryEntries.length > 0 ? [...unhandled, ...retryEntries] : unhandled
      }
      const handleResult = (idx: number, data?: CheckResult) => {
        handled.add(idx)
        const e = task.entries[idx]
        if (!e) return
        if (!data) {
          sawTransient = true
          e.lastError = "No result returned."
          retryEntries.push(e)
          return
        }
        if (data.errorCategory) {
          const msg = data.message || errorLabel(data.errorCategory)
          // PRIORITIZE AUTO-RETRY: retry every error except a genuinely fatal one
          // (bad/empty cookie). A bulk error is almost always a blocked/slow proxy,
          // so re-dialing on a fresh proxy resolves it — a finished run should leave
          // no transient errors behind. A per-cookie proxy error is NOT a congestion
          // signal (the server already failed over), so it must NOT mark the batch
          // transient (which would halve the window and stall the run).
          if (bulkShouldRetry(data.errorCategory)) {
            e.lastError = msg
            e.lastResult = data
            retryEntries.push(e)
          } else {
            setStatusMany(e.ids, { status: "error", error: msg, result: data })
          }
        } else {
          setCachedResult(e.cookie, data)
          const alive = isAliveResult(data)
          setStatusMany(e.ids, { status: alive ? "alive" : "dead", result: data })
          if (alive) {
            // Persist the FULL service cookie set from the row's ORIGINAL raw input
            // (e.cookie is only the lean auth slice used for checking). This keeps
            // every cookie a browser needs to restore the session — essential for
            // Prime, which needs more than the single `at-main` auth token.
            const raw = rowMapRef.current.get(e.ids[0])?.raw
            const stored = (raw && cookieForStorage(raw, service)) || e.cookie
            aliveBatch.push({ cookie: stored, result: data })
          }
        }
      }

      let response
      try {
        response = await checkCookieBatch(cookies, ac.signal, {
          includeLinks: includeLinksRef.current,
  useProxies: useProxiesRef.current,
  manualProxies: manualProxiesRef.current,
  service,
          // Apply each verdict the moment it streams back, not after the whole batch.
          onResult: handleResult,
        })
      } catch (err) {
        if (ac.signal.aborted) {
          // Only the entries that never finalized revert to stopped — a cookie
          // already resolved to alive/dead stays resolved.
          for (const e of pendingForRetry()) setStatusMany(e.ids, { status: "stopped" })
          return { transient: false }
        }
        const pending = pendingForRetry()
        for (const e of pending) e.lastError = err instanceof Error && err.message ? err.message : "Request failed."
        requeue(task.attempt, pending)
        // A network-level failure is a real transient (not a proxy issue), so the
        // controller should apply a brief cooldown.
        return { transient: true }
      }

      // Whole-batch rate-limit (429) from the server itself — genuine congestion.
      // Only requeue cookies that DIDN'T already get a final streamed verdict, so a
      // row already shown alive/dead is never reverted to retrying (which would make
      // progress go backwards / a "finished" run look unfinished).
      if (response.rateLimited) {
        const msg = "Rate limited — backing off."
        const pending = pendingForRetry()
        for (const e of pending) e.lastError = msg
        requeue(task.attempt, pending)
        return { transient: true, retryAfterMs: response.retryAfterMs }
      }
      // Whole-batch client timeout (our 65s safety net fired). Requeue ONLY the
      // entries still unresolved (or that streamed a retryable error) — final
      // alive/dead verdicts that already arrived stay final. Not a congestion
      // event — a platform issue, not Netflix refusing connections.
      if (response.timedOut) {
        const pending = pendingForRetry()
        for (const e of pending) e.lastError = "Timed out — retrying."
        requeue(task.attempt, pending)
        return { transient: false }
      }

      // Adopt the server's WORKING-proxy count as our concurrency ceiling.
      // More good proxies → more lanes immediately.
      ctrl.ceiling = ceilingFor(response.proxies ?? 0, turboRef.current)

      // Most verdicts were already applied live via handleResult as they streamed.
      // Sweep up any entry that never received a streamed result (e.g. the stream
      // ended early) and treat it as a no-result retry so nothing is left hanging.
      task.entries.forEach((e, idx) => {
        if (!handled.has(idx)) handleResult(idx, response.results[idx])
      })
      if (onAlive && aliveBatch.length > 0) onAlive(aliveBatch)
      requeue(task.attempt, retryEntries)
      return { transient: sawTransient }
    }

    // ---- Scheduler pump: keep `ctrl.limit` batches in flight, honor cooldowns,
    // stagger starts so we never burst a herd of TLS handshakes at Netflix.
    await new Promise<void>((resolve) => {
      let settled = false
      // HEARTBEAT: tick the scheduler on a steady cadence so a freshly-scraped
      // working proxy opens a new lane RIGHT AWAY, even while every current lane is
      // busy mid-batch. Without it, pump() only re-runs when a batch finishes, so a
      // new proxy would sit unused until an in-flight batch completed.
      const heartbeat = setInterval(() => pump(), HEARTBEAT_MS)
      const finish = () => {
        if (settled) return
        settled = true
        clearInterval(heartbeat)
        resolve()
      }
      const pump = () => {
        if (settled) return
        if (ac.signal.aborted) {
          if (ctrl.inFlight === 0) finish()
          return
        }

        // Proactively update the ceiling every tick from the LIVE client proxy count
        // so a freshly-scraped proxy raises the window immediately — without needing
        // to wait for the next batch response to carry the count back.
        const liveNow = proxyCountNow()
        if (liveNow > 0) {
          const freshCeiling = ceilingFor(liveNow, turboRef.current)
          if (freshCeiling > ctrl.ceiling) ctrl.ceiling = freshCeiling
          // SCALE THREADS WITH PROXIES: since each lane dials a DIFFERENT proxy and
          // the server fails over per cookie, more working proxies should mean more
          // active lanes RIGHT NOW — not after a slow AIMD ramp. As long as we're not
          // in a genuine congestion cooldown/hold, snap the active limit straight up
          // to the proxy-derived ceiling. (Single-IP runs have no proxies here, so
          // they keep the conservative AIMD ramp below.)
          const tNow = Date.now()
          const healthy = tNow >= ctrl.holdUntil && tNow >= ctrl.cooldownUntil
          if (healthy && ctrl.limit < ctrl.ceiling) ctrl.limit = ctrl.ceiling
        }

        if (queue.length === 0 && ctrl.inFlight === 0) {
          // Main work drained. If cookies were set aside, come back for them in a
          // fresh pass on newly-scraped proxies. KEY FIX: as long as the live proxy
          // pool is still GROWING (the background scraper keeps verifying new exit
          // IPs), each pass is a genuinely new shot, so it must NOT count toward
          // giving up — that's what stops a run from getting "stuck" / bailing while
          // fresh proxies are still arriving. Only passes that bring NO new proxies
          // burn the budget, and an empty pool waits for fresh IPs before retrying.
          if (deferred.length > 0) {
            const proxiesNow = proxyCountNow()
            // Did the working-proxy pool GROW since our last deferred pass? A larger
            // pool means genuinely new exit IPs to try — the exact thing that turns a
            // previously-failing row into a pass.
            const gotFreshProxies = proxiesNow > lastPassProxyCount
            if (gotFreshProxies) unproductivePasses = 0
            else unproductivePasses++
            lastPassProxyCount = proxiesNow
            const giveUp = unproductivePasses > MAX_PASSES || pass >= HARD_PASS_CAP
            if (!giveUp) {
              pass++
              const toRetry = deferred
              deferred = []
              for (let i = 0; i < toRetry.length; i += BATCH_SIZE) {
                queue.push({ entries: toRetry.slice(i, i + BATCH_SIZE), attempt: 0 })
              }
              setAnnouncement(
                `Retrying ${toRetry.length} deferred ${toRetry.length === 1 ? "cookie" : "cookies"} (pass ${pass})…`,
              )
              // Retry timing:
              // • Fresh proxies available → re-dial ALMOST IMMEDIATELY. A new working
              // proxy is precisely what lets the frozen rows succeed, so there's no
              // reason to sit on the slow recovery delay — this is what stops the
              // run stalling on its final stragglers.
              // • Proxies exist but the pool didn't grow → brief recovery pause.
              // • Pool empty → wait longer for the scraper to deliver fresh exit IPs
              // rather than instantly re-failing on an empty pool.
              const wait =
                proxiesNow === 0
                  ? Math.max(PASS_RECOVERY_MS, 3_500)
                  : gotFreshProxies
                    ? FRESH_PROXY_RETRY_MS
                    : PASS_RECOVERY_MS
              // Don't let a lingering congestion cooldown hold back an immediate
              // fresh-proxy retry — clear it so these rows dispatch right away.
              ctrl.cooldownUntil = gotFreshProxies ? Date.now() : Math.max(ctrl.cooldownUntil, Date.now() + wait)
              setTimeout(pump, wait + 20)
              return
            }
            // Truly exhausted (pool stopped growing): finalize stragglers as errors.
            for (const e of deferred) {
              setStatusMany(e.ids, {
                status: "error",
                error: e.lastError ?? "Could not reach Netflix.",
                result: e.lastResult,
              })
            }
            deferred = []
          }
          finish()
          return
        }

        // WAIT FOR A GOOD PROXY BEFORE (RE)CHECKING. This run routes through live
        // proxies, so dispatching while the pool is momentarily empty would dial
        // Netflix from the bare server IP (and instantly fail/throttle). Whenever
        // there's work queued but zero working proxies right now, hold the tick and
        // re-pump shortly — the background scraper streams fresh exit IPs continuously,
        // so as soon as ONE good proxy lands we resume. This also covers RETRYING
        // rows: a requeued cookie simply waits here for a good proxy, then re-checks.
        if (useProxiesRef.current && queue.length > 0 && ctrl.inFlight === 0 && proxyCountNow() === 0) {
          // Note the first instant the pool went empty so the safety valve below can
          // measure how long we've been totally without a proxy.
          if (emptyPoolSince === 0) emptyPoolSince = Date.now()
          if (Date.now() - emptyPoolSince > NO_PROXY_GIVEUP_MS) {
            // Total proxy drought: finalize every remaining cookie as an error so the
            // run terminates instead of waiting on a pool that isn't refilling.
            for (const task of queue) {
              for (const e of task.entries) {
                setStatusMany(e.ids, {
                  status: "error",
                  error: e.lastError ?? "No working proxy available.",
                  result: e.lastResult,
                })
              }
            }
            queue.length = 0
            finish()
            return
          }
          setAnnouncement("Waiting for a working proxy…")
          setTimeout(pump, 200)
          return
        }
        // Pool has at least one proxy (or we're not proxy-gated): reset the drought timer.
        emptyPoolSince = 0

        const now = Date.now()
        if (now < ctrl.cooldownUntil) {
          // Breaker/backoff active: re-pump when the cooldown elapses.
          // EXCEPT: if the queue already has retries (attempt > 0) AND we currently
          // have working proxies to dial, dispatch them immediately so RETRYING rows
          // don't sit idle on a congestion cooldown that doesn't apply to a fresh
          // proxy. With no proxies available we never bypass the cooldown — the gate
          // above already parked us until a good proxy arrives.
          const hasRetries = queue.some((t) => t.attempt > 0)
          const canUseProxiesNow = !useProxiesRef.current || proxyCountNow() > 0
          if (!hasRetries || !canUseProxiesNow) {
            setTimeout(pump, ctrl.cooldownUntil - now + 20)
            return
          }
          // Fall through to dispatch retries even during cooldown.
        }

        // Fill as many open lanes as possible in a single tick, staggering each
        // start by DISPATCH_STAGGER_MS to avoid a TLS thundering-herd. We loop
        // instead of recursing once so the full window fills quickly: at 30ms stagger
        // and 20 open slots that's 600ms to fill — acceptable. Without this loop the
        // old code only dispatched 1 task per pump() invocation, so "10 at a time"
        // was actually "1 dispatched then wait 30ms, then 1 more…".
        let dispatched = 0
        while (ctrl.inFlight < ctrl.limit && queue.length > 0) {
          // During a cooldown, only dispatch retries (not fresh tasks).
          if (now < ctrl.cooldownUntil) {
            const idx = queue.findIndex((t) => t.attempt > 0)
            if (idx === -1) break
            const [task] = queue.splice(idx, 1)
            ctrl.inFlight++
            dispatched++
            void dispatchTask(task)
              .then(({ transient, retryAfterMs }) => {
                recordOutcome(transient, retryAfterMs)
              })
              .catch((err) => {
                // A worker must never strand an in-flight lane. Convert unexpected
                // client-side failures into bounded retries and always release it.
                if (!ac.signal.aborted) {
                  for (const e of task.entries) e.lastError = err instanceof Error ? err.message : "Worker failed."
                  requeue(task.attempt, task.entries)
                }
              })
              .finally(() => {
                ctrl.inFlight--
                announce()
                pump()
              })
          } else {
            const task = queue.shift()!
            ctrl.inFlight++
            dispatched++
            void dispatchTask(task)
              .then(({ transient, retryAfterMs }) => {
                recordOutcome(transient, retryAfterMs)
              })
              .catch((err) => {
                // A worker must never strand an in-flight lane. Convert unexpected
                // client-side failures into bounded retries and always release it.
                if (!ac.signal.aborted) {
                  for (const e of task.entries) e.lastError = err instanceof Error ? err.message : "Worker failed."
                  requeue(task.attempt, task.entries)
                }
              })
              .finally(() => {
                ctrl.inFlight--
                announce()
                pump()
              })
          }
          if (dispatched > 1) {
            // Stagger subsequent lanes so we don't burst the full window at once.
            setTimeout(pump, DISPATCH_STAGGER_MS)
            break
          }
        }
      }
      pump()
    })

    if (ac.signal.aborted) {
      for (const r of currentRows()) {
        if (r.status === "checking" || r.status === "retrying" || r.status === "queued") {
          setStatus(r.id, { status: "stopped" })
        }
      }
    }

    // Apply whatever is still buffered from the last in-flight checks.
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    flush()

    setRunning(false)
    setPreparing(false)
    stopReplenish()
    // Freeze the elapsed clock at the final run duration.
    if (runStartRef.current != null) setElapsedMs(Date.now() - runStartRef.current)
    if (!ac.signal.aborted) {
      const finalRows = currentRows()
      const errs = finalRows.filter((r) => r.status === "error").length
      // Recheck mode: report each account's outcome (by saved-cookie id) so the
      // caller can delete the expired ones and refresh the list.
      if (recheckMode && onRunComplete) {
        const pick = (status: RowStatus) =>
          finalRows.filter((r) => r.status === status && r.key).map((r) => r.key as string)
        onRunComplete({
          alive: pick("alive"),
          dead: pick("dead"),
          errored: pick("error"),
          total: finalRows.length,
        })
      } else if (errs === 0) {
        toast.success("Bulk check complete.")
        playComplete()
      } else {
        toast.warning(`Complete with ${errs} error(s). Use “Retry failed” to try them again.`)
        // Still a finished run, but flag the errors with the distinct error tone.
        playError()
      }
      setAnnouncement("Check complete.")
      // Surface the detailed, close-button-only results modal for public runs.
      if (!recheckMode) {
        setHasCompleted(true)
        setResultsOpen(true)
      }
    }
  }

  function runAll() {
    void runChecks(rows)
  }

  // Re-runs only the DEAD cookies (expired/invalid on the previous pass) — exposed
  // as the primary action once a run completes, since a fresh proxy/session can
  // occasionally revive a cookie that briefly read as dead.
  function recheckDead() {
    const dead = rows.filter((r) => r.status === "dead")
    if (dead.length === 0) {
      toast.info("No dead cookies to recheck.")
      return
    }
    void runChecks(dead, { bypassCache: true })
  }

  // Re-runs only rows that errored (transient failures), leaving alive/dead as-is.
  function retryFailed() {
    const failed = rows.filter((r) => r.status === "error")
    if (failed.length === 0) {
      toast.info("No failed cookies to retry.")
      return
    }
    void runChecks(failed)
  }

  function stopAll() {
    abortRef.current?.abort()
    setRunning(false)
    setPaused(false)
    setPreparing(false)
    stopReplenish()
    toast.info("Stopping… in-flight checks were cancelled.")
  }

  // Pause: cancel in-flight work but KEEP all progress. Rows that were mid-check
  // revert to queued so Resume can pick them up. Distinct from Stop, which ends
  // the run outright.
  function pauseRun() {
    abortRef.current?.abort()
    setRunning(false)
    setPaused(true)
    setPreparing(false)
    stopReplenish()
    setRows((prev) =>
      prev.map((r) =>
        r.status === "checking" || r.status === "retrying" || r.status === "stopped" ? { ...r, status: "queued" } : r,
      ),
    )
    toast.info("Paused. Click Resume to continue where you left off.")
  }

  // Resume: re-run everything that hasn't reached a final verdict yet — queued,
  // stopped, and retryable errors — while leaving alive/dead (and permanent
  // errors like invalid cookies) untouched.
  function resumeRun() {
    const todo = rows.filter(
      (r) =>
        r.status !== "alive" &&
        r.status !== "dead" &&
        !(r.status === "error" && r.result && !bulkShouldRetry(r.result.errorCategory)),
    )
    if (todo.length === 0) {
      setPaused(false)
      toast.info("Nothing left to check.")
      return
    }
    void runChecks(todo)
  }

  function clearAll() {
    abortRef.current?.abort()
    rowMapRef.current = new Map()
    rowIdsRef.current = []
    bumpVersion()
    setText("")
    setRunning(false)
    setPaused(false)
    setHasCompleted(false)
    setResultsOpen(false)
    setElapsedMs(0)
    runStartRef.current = null
    clearBulkSnapshot(storageKey)
  }

  // ----- Exports -----
  function download(filename: string, content: string, type = "text/plain") {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const aliveRows = rows.filter((r) => r.status === "alive")
  // Dead (expired/invalid) cookies, for the "Dead only" export group.
  const deadRows = rows.filter((r) => r.status === "dead")
  // "Logs in but can't stream" accounts — dead, yet the login still works, so they
  // get their own full-details export group per service:
  //   • Netflix  → payment-failure hold  (membershipOnHold)
  //   • Prime    → "No Prime"             (signed in, no active Prime sub)
  //   • Crunchyroll → "No subscription"   (authenticates, free/no premium)
  // Only the current service's variant is shown (see the menu items below).
  const onHoldRows = rows.filter((r) => r.status === "dead" && r.result?.membershipOnHold === true)
  const noPrimeRows = rows.filter((r) => r.status === "dead" && /no prime/i.test(r.result?.plan ?? ""))
  const noSubRows = rows.filter((r) => r.status === "dead" && /no subscription/i.test(r.result?.plan ?? ""))
  // Rows currently shown by the filters, and the alive subset of those.
  const filteredRows = visibleRows.map((v) => v.row)
  const filteredAliveRows = filteredRows.filter((r) => r.status === "alive")

  // ----- Generic export helpers (work on any row list) -----
  // Building the export text for thousands of rows is CPU-heavy (each row parses &
  // re-serializes its cookies). Doing it synchronously on click froze the tab, so
  // everything below routes through `mapChunked`, which yields to the event loop
  // between chunks. A shared busy guard blocks overlapping exports, and any list
  // large enough to take a moment shows a live progress toast. Only the FINAL
  // clipboard write happens after the async build; copyText detects the expired
  // user-activation and automatically uses its execCommand fallback, so large
  // copies still land on the clipboard.
  const exportingRef = useRef(false)

  // Builds the joined human-readable details for a list without blocking the UI.
  async function buildDetailsText(list: Row[], onProgress?: (done: number, total: number) => void) {
    const blocks = await mapChunked(
      list,
      (r, i) => buildAccountDetails(r.result as CheckResult, r.raw, { index: i + 1, total: list.length }, service),
      { onProgress },
    )
    return joinAccountDetails(blocks)
  }

  // Shows/updates a single progress toast, but only when the list is big enough
  // for the build to be noticeable (small lists finish instantly). Returns a
  // handle whose `onProgress` updates the toast in place and `dismiss()` clears it.
  function progressReporter(noun: string, verb: string) {
    let toastId: string | number | undefined
    return {
      onProgress: (done: number, total: number) => {
        if (total < 400) return
        const pct = Math.round((done / total) * 100)
        const msg = `${verb} ${noun}… ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`
        toastId = toast.loading(msg, toastId === undefined ? undefined : { id: toastId })
      },
      dismiss: () => {
        if (toastId !== undefined) toast.dismiss(toastId)
      },
    }
  }

  async function copyDetailsOf(list: Row[], noun: string) {
    if (list.length === 0) return toast.info(`No ${noun} results to copy.`)
    if (exportingRef.current) return toast.info("Another export is still running…")
    exportingRef.current = true
    const rep = progressReporter(noun, "Preparing")
    try {
      const text = await buildDetailsText(list, rep.onProgress)
      const ok = await copyText(text)
      rep.dismiss()
      ok ? toast.success(`Copied ${list.length.toLocaleString()} result(s).`) : toast.error("Couldn't copy.")
    } finally {
      exportingRef.current = false
    }
  }

  // Downloads the SAME human-readable details text that "Copy details" produces,
  // as a plain .txt file (the only download format we offer now).
  async function downloadDetailsOf(list: Row[], filename: string, noun: string) {
    if (list.length === 0) return toast.info(`No ${noun} results to export.`)
    if (exportingRef.current) return toast.info("Another export is still running…")
    exportingRef.current = true
    const rep = progressReporter(noun, "Preparing")
    try {
      const text = await buildDetailsText(list, rep.onProgress)
      rep.dismiss()
      download(filename, text, "text/plain")
      toast.success(`Exported ${list.length.toLocaleString()} result(s).`)
    } finally {
      exportingRef.current = false
    }
  }

  // Cookies are exported/copied as browser-importable Cookie-Editor / EditThisCookie
  // JSON arrays — the one-click "Import" format that loads a working session into any
  // browser. A single account yields one valid JSON array; multiple accounts get a
  // labeled header per account so each importable array is easy to find and copy out.
  // Built via mapChunked so a huge alive-list never freezes the tab.
  async function buildCookiesBlob(list: Row[], onProgress?: (done: number, total: number) => void): Promise<string> {
    const blocks = await mapChunked(
      list,
      (r, i) => {
        const json = cookieToCookieEditorJson(r.raw, service)
        const who = (r.result as CheckResult)?.email || `account ${i + 1}`
        return list.length > 1 ? `// ===== ${who} =====\n${json}` : json
      },
      { onProgress },
    )
    return blocks.join("\n\n")
  }

  async function copyCookiesOf(list: Row[], noun: string) {
    if (list.length === 0) return toast.info(`No ${noun} cookies to copy.`)
    if (exportingRef.current) return toast.info("Another export is still running…")
    exportingRef.current = true
    const rep = progressReporter(`${noun} cookies`, "Preparing")
    try {
      const blob = await buildCookiesBlob(list, rep.onProgress)
      const ok = await copyText(blob)
      rep.dismiss()
      ok
        ? toast.success(`Copied ${list.length.toLocaleString()} ${noun} cookie(s).`)
        : toast.error("Couldn't copy.")
    } finally {
      exportingRef.current = false
    }
  }

  const hasRows = rows.length > 0
  const progress = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0

  // Mirror the live run state to an optional external listener (the admin header's
  // global status pill). Runs only when the relevant values actually change.
  useEffect(() => {
    onRunStateChange?.({
      running,
      paused,
      preparing,
      total: counts.total,
      done: counts.done,
      alive: counts.alive,
      dead: counts.dead,
      error: counts.error,
      progress,
    })
  }, [running, paused, preparing, counts, progress, onRunStateChange])
  // Rows that a Resume would re-check: still-pending plus retryable errors.
  const resumableCount = rows.filter(
    (r) => r.status === "queued" || (r.status === "error" && (!r.result || bulkShouldRetry(r.result.errorCategory))),
  ).length

  return (
    <div className="flex flex-col gap-5">
      {/* Input panel */}
      <section className="flex flex-col gap-5 rounded-md glass p-6 sm:p-7">
        {recheckMode ? (
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold uppercase tracking-widest text-foreground">
              Recheck Saved Accounts
            </h2>
            <p className="text-sm font-medium text-muted-foreground">
              Checks every saved account again to confirm it still works, then removes the expired ones for you
              automatically.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold uppercase tracking-widest text-foreground">Bulk Check</h2>
              <p className="text-sm font-medium text-muted-foreground">
                Paste as many cookies as you like, or upload your saved files and folders — even .zip and .rar archives.
                We read every common format automatically, so there&apos;s nothing to clean up first.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Paste */}
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="bulk"
                    className="text-xs font-semibold uppercase tracking-widest text-muted-foreground"
                  >
                    Paste Cookies
                  </label>
                  {pastedCount > 0 && (
                    <span className="text-[11px] font-semibold tracking-widest text-accent">
                      {pastedCount} detected
                    </span>
                  )}
                </div>
                <textarea
                  id="bulk"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    service === "prime"
                      ? "at-main=...; sess-at-main=...; ubid-main=...; session-id=...\nat-main=...; sess-at-main=...; ubid-main=...\n…"
                      : service === "crunchyroll"
                        ? "etp_rt=...\netp_rt=...\n…"
                        : service === "steam"
                          ? "steamLoginSecure=...; sessionid=...\nsteamLoginSecure=...; sessionid=...\n…"
                          : service === "spotify"
                            ? "sp_dc=...\nsp_dc=...\n��"
                            : "NetflixId=...; SecureNetflixId=...\nNetflixId=...; SecureNetflixId=...\n…"
                  }
                  rows={7}
                  spellCheck={false}
                  className="w-full flex-1 resize-y rounded-md border border-border bg-card px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                />
                <Button type="button" variant="secondary" size="sm" disabled={!text.trim()} onClick={loadFromPaste}>
                  <ListChecks className="size-3.5" aria-hidden />
                  Load {pastedCount > 0 ? `${pastedCount} ` : ""}from paste
                </Button>
              </div>

              {/* Dropzone */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Upload Files
                </span>
                <label
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    void handleFiles(e.dataTransfer.files)
                  }}
                  className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center transition-colors ${
                    dragging ? "border-foreground bg-primary/20" : "border-foreground bg-card hover:bg-muted"
                  }`}
                >
                  {loadingFiles ? (
                    <Spinner className="size-6 text-foreground" thickness={3} aria-hidden />
                  ) : (
                    <FileUp className="size-6 text-foreground" aria-hidden />
                  )}
                  <span className="text-sm font-semibold uppercase tracking-widest text-foreground">
                    {loadingFiles ? "Reading files…" : "Drop files · click to browse"}
                  </span>
                  <span className="text-[11px] font-medium text-muted-foreground">
                    .txt .json .csv .log .har + .zip / .gz / .rar archives (auto-extracted, all folders)
                  </span>
                  <input
                    type="file"
                    multiple
                    accept=".txt,.text,.md,.json,.ndjson,.jsonl,.csv,.tsv,.log,.out,.cookies,.cookie,.netscape,.header,.headers,.har,.dat,.conf,.cfg,.ini,.env,.nfo,.zip,.zipx,.cbz,.jar,.xpi,.epub,.gz,.gzip,.tgz,.rar,text/plain,application/json,application/zip,application/gzip,application/vnd.rar,application/x-rar-compressed"
                    className="hidden"
                    onChange={(e) => {
                      void handleFiles(e.target.files)
                      e.target.value = ""
                    }}
                  />
                </label>
              </div>
            </div>
          </>
        )}

        {!recheckMode && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
            <div
              role="status"
              aria-live="polite"
              className={autoProxyScrapeEnabled
                ? "flex flex-col gap-1 rounded-md border-2 border-primary bg-primary/10 px-4 py-3 text-foreground"
                : "flex flex-col gap-1 rounded-md border-2 border-destructive bg-destructive/10 px-4 py-3 text-foreground"}
            >
              <p className="text-xs font-bold uppercase tracking-widest">
                Administrator setting: Automatic proxy scraping is {autoProxyScrapeEnabled ? "ON" : "OFF"}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {autoProxyScrapeEnabled
                  ? "This checker may use automatically discovered proxies when no manual list is active."
                  : "Public checkers must use the manual proxy list below. Automatic scraping is disabled by the administrator."}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-foreground">Your proxy selection</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {manualMode ? "Manual proxy rotation is active for this browser." : "Automatic proxy scraping is active for this browser only when no manual proxies are entered."}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!manualMode}
                disabled={running || !autoProxyScrapeEnabled}
                onClick={() => {
                  if (manualMode && autoProxyScrapeEnabled) {
                    setManualProxyText("")
                    setManualProxies([])
                  }
                }}
                className={!manualMode && autoProxyScrapeEnabled
                  ? "inline-flex h-10 items-center rounded-md border border-border bg-primary px-4 text-xs font-semibold uppercase tracking-widest text-primary-foreground"
                  : "inline-flex h-10 items-center rounded-md border border-border bg-muted px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground"}
              >
                Browser mode: {!manualMode && autoProxyScrapeEnabled ? "AUTO" : "MANUAL"}
              </button>
            </div>
            <textarea
              value={manualProxyText}
              onChange={(event) => {
                const value = event.target.value
                setManualProxyText(value)
                setManualProxies(parseProxyBlock(value))
              }}
              disabled={running}
              rows={4}
              spellCheck={false}
              placeholder="http://user:password@host:port\nsocks5://host:port\nhost:port:user:password"
              className="w-full resize-y rounded-md border border-border bg-background px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:opacity-60"
              aria-label="Manual proxies, one per line"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs font-semibold uppercase tracking-widest text-foreground hover:bg-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                <FileUp className="size-3.5" aria-hidden />
                Upload proxy .txt
                <input
                  type="file"
                  accept=".txt,.text,.csv,.log,.list,text/plain,text/csv"
                  multiple
                  className="hidden"
                  disabled={running}
                  onChange={(event) => {
                    void handleProxyFile(event.target.files)
                    event.target.value = ""
                  }}
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                {manualProxies.length > 0
                  ? `${manualProxies.length} manual pro${manualProxies.length === 1 ? "xy" : "xies"} ready; all common formats are normalized automatically.`
                  : "Leave empty to use Auto Proxy Scrape."}
              </p>
            </div>
          </div>
        )}

        {/* Proxy pre-flight banner: shown while we scrape + Netflix-test the first
        working proxies before a proxy-backed run begins. */}
        {preparing && (
          <div
            role="status"
            className="flex items-center gap-2.5 rounded-md border border-border bg-info/15 px-4 py-3 text-sm font-bold text-foreground duration-300 animate-in fade-in-0 slide-in-from-top-1"
          >
            <Spinner className="size-4 shrink-0 text-foreground" thickness={3} aria-hidden />
            <span>
              {announcement || "Preparing fresh proxies — scraping and testing against Netflix before starting…"}
            </span>
          </div>
        )}

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <Button type="button" variant="secondary" size="lg" className="h-10" onClick={pauseRun}>
                <Pause className="size-4" aria-hidden />
                Pause
              </Button>
              <Button type="button" variant="destructive" size="lg" className="h-10" onClick={stopAll}>
                <Square className="size-4" aria-hidden />
                Stop
              </Button>
            </>
          ) : paused ? (
            <>
              <Button type="button" size="lg" className="h-10" onClick={resumeRun}>
                <Play className="size-4" aria-hidden />
                Resume{resumableCount > 0 ? ` (${resumableCount})` : ""}
              </Button>
              <Button type="button" variant="outline" size="lg" className="h-10" onClick={stopAll}>
                <Square className="size-4" aria-hidden />
                End run
              </Button>
            </>
          ) : hasCompleted && !recheckMode ? (
            <>
              <Button type="button" size="lg" className="h-10" disabled={counts.dead === 0} onClick={recheckDead}>
                <RotateCcw className="size-4" aria-hidden />
                Recheck dead cookies{counts.dead > 0 ? ` (${counts.dead})` : ""}
              </Button>
              <Button type="button" variant="outline" size="lg" className="h-10" onClick={() => setResultsOpen(true)}>
                <ListChecks className="size-4" aria-hidden />
                View results
              </Button>
            </>
          ) : (
            <Button type="button" size="lg" className="h-10" disabled={!hasRows} onClick={runAll}>
              <Play className="size-4" aria-hidden />
              {recheckMode ? "Recheck all" : "Check all"}
              {hasRows ? ` (${counts.total})` : ""}
            </Button>
          )}

          {!running && !paused && counts.error > 0 && (
            <Button type="button" variant="outline" size="lg" className="h-10" onClick={retryFailed}>
              <RotateCcw className="size-4" aria-hidden />
              Retry failed ({counts.error})
            </Button>
          )}

          {isNetflix && (
            <button
              type="button"
              role="switch"
              aria-checked={includeLinks}
              disabled={running}
              onClick={() => setIncludeLinks((v) => !v)}
              title="Also generate Netflix login links for alive cookies. Slower — adds one upstream request per alive cookie."
              className={
                includeLinks
                  ? "inline-flex h-11 items-center gap-1.5 rounded-md border border-border bg-primary px-4 text-sm font-semibold uppercase tracking-widest text-primary-foreground transition-all duration-75 disabled:opacity-50"
                  : "inline-flex h-11 items-center gap-1.5 rounded-md border border-border bg-card px-4 text-sm font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              }
            >
              <Link2 className="size-4" aria-hidden />
              Auth Links: {includeLinks ? "On" : "Off"}
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={!hasRows}
              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border bg-card px-4 text-sm font-semibold uppercase tracking-widest text-foreground transition-all duration-75 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-primary aria-expanded:text-primary-foreground"
            >
              <Download className="size-4" aria-hidden />
              Export
              <ChevronDown className="size-3.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Alive only</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => copyDetailsOf(aliveRows, "alive")}>
                  <Copy className="size-4" aria-hidden />
                  Copy alive details ({counts.alive})
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={aliveRows.length === 0}
                  onClick={() => downloadDetailsOf(aliveRows, "alive-accounts.txt", "alive")}
                >
                  <FileText className="size-4" aria-hidden />
                  Download alive (.txt) ({counts.alive})
                </DropdownMenuItem>
              </DropdownMenuGroup>

              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Dead only</DropdownMenuLabel>
                <DropdownMenuItem disabled={deadRows.length === 0} onClick={() => copyCookiesOf(deadRows, "dead")}>
                  <Copy className="size-4" aria-hidden />
                  Copy dead cookies ({counts.dead})
                </DropdownMenuItem>
                {isNetflix && (
                  <DropdownMenuItem
                    disabled={onHoldRows.length === 0}
                    onClick={() => copyDetailsOf(onHoldRows, "on-hold")}
                  >
                    <CircleAlert className="size-4" aria-hidden />
                    Copy on-hold details ({onHoldRows.length})
                  </DropdownMenuItem>
                )}
                {service === "prime" && (
                  <DropdownMenuItem
                    disabled={noPrimeRows.length === 0}
                    onClick={() => copyDetailsOf(noPrimeRows, "no-Prime")}
                  >
                    <CircleAlert className="size-4" aria-hidden />
                    Copy no-Prime details ({noPrimeRows.length})
                  </DropdownMenuItem>
                )}
                {service === "crunchyroll" && (
                  <DropdownMenuItem
                    disabled={noSubRows.length === 0}
                    onClick={() => copyDetailsOf(noSubRows, "no-subscription")}
                  >
                    <CircleAlert className="size-4" aria-hidden />
                    Copy no-subscription details ({noSubRows.length})
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>

              {/* Filtered group only appears once a filter is actually applied. */}
              {filtersActive && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Filtered — {filteredRows.length} shown</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={filteredAliveRows.length === 0}
                      onClick={() => copyDetailsOf(filteredAliveRows, "filtered")}
                    >
                      <Copy className="size-4" aria-hidden />
                      Copy filtered details ({filteredAliveRows.length})
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={filteredAliveRows.length === 0}
                      onClick={() => downloadDetailsOf(filteredAliveRows, "filtered-accounts.txt", "filtered")}
                    >
                      <FileText className="size-4" aria-hidden />
                      Download filtered (.txt) ({filteredAliveRows.length})
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-10"
            disabled={!hasRows && !text.trim()}
            onClick={clearAll}
          >
            <Trash2 className="size-4" aria-hidden />
            Clear
          </Button>
        </div>

        {/* Screen-reader live announcements for run progress and completion. */}
        <p aria-live="polite" role="status" className="sr-only">
          {announcement}
        </p>
      </section>

      {/* Results */}
      {hasRows && (
        <section className="flex flex-col gap-4 rounded-md glass p-6 duration-400 anim-condense sm:p-7">
          {/* Summary */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SummaryChip icon={Layers} label="Total" value={counts.total} tone="muted" />
              <SummaryChip icon={CircleCheck} label="Alive" value={counts.alive} tone="success" />
              <SummaryChip icon={CircleX} label="Dead" value={counts.dead} tone="muted" />
              <SummaryChip icon={CircleAlert} label="Errors" value={counts.error} tone="destructive" />
              {paused && (
                <span className="inline-flex items-center gap-1 rounded-md border border-border bg-warning px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-warning-foreground">
                  <Pause className="size-3" aria-hidden />
                  Paused
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs font-bold text-muted-foreground">
                <Clock className="size-3.5" aria-hidden />
                <span className={running || preparing ? "text-foreground" : ""}>{formatElapsed(elapsedMs)}</span>
              </span>
              <span className="font-mono text-xs font-bold text-muted-foreground">
                {counts.done}/{counts.total} checked
              </span>
            </div>
            <div className="h-4 w-full overflow-hidden rounded-md border border-border bg-card">
              <div
                className={`h-full rounded-md transition-[width] duration-500 ease-out ${paused ? "bg-warning" : "bg-accent"}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <Filter className="size-3.5" aria-hidden />
              Filters
            </span>
            <FilterSelect
              label="Status"
              value={statusFilter}
              options={["alive", "dead", "error"]}
              onChange={setStatusFilter}
            />
            <FilterSelect label="Plan" value={planFilter} options={planOptions} onChange={setPlanFilter} />
            <FilterSelect label="Country" value={countryFilter} options={countryOptions} onChange={setCountryFilter} />
            {filtersActive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatusFilter("all")
                  setPlanFilter("all")
                  setCountryFilter("all")
                }}
              >
                Reset
              </Button>
            )}
            <span className="ml-auto text-xs font-bold text-muted-foreground">
              Showing {visibleRows.length} of {rows.length}
            </span>
          </div>

          {/* Rows — virtualized so only on-screen rows are in the DOM, keeping
 memory flat and scrolling smooth even with tens of thousands of rows. */}
          <div className="rounded-md border border-border bg-card">
            {visibleRows.length > 0 ? (
              <VirtualResultList items={visibleRows} service={service} linksOnly={linksOnly} />
            ) : (
              <p className="px-4 py-8 text-center text-sm font-medium text-muted-foreground">
                No results match the current filters.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Post-run results modal — close-button ONLY (no overlay-click / Escape close). */}
      {resultsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Bulk check results"
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/60 p-4 duration-200 animate-in fade-in-0"
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-md border border-border bg-card shadow-lg duration-200 animate-in zoom-in-95">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-border bg-primary px-5 py-3">
              <div className="flex flex-col">
                <h2 className="text-base font-semibold uppercase tracking-widest text-primary-foreground">
                  {running ? "Rechecking Dead…" : "Bulk Check Complete"}
                </h2>
                <p className="font-mono text-xs font-bold text-primary-foreground/80">
                  {counts.done}/{counts.total} checked · {formatElapsed(elapsedMs)} elapsed
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResultsOpen(false)}
                aria-label="Close results"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground shadow-lg transition-all duration-75 hover:bg-muted "
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>

            {/* Exports */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4">
              <DropdownMenu>
                <DropdownMenuTrigger className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-md border border-border bg-card px-4 text-sm font-semibold uppercase tracking-widest text-foreground outline-none transition-all duration-75 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-expanded:bg-primary aria-expanded:text-primary-foreground">
                  <Download className="size-4" aria-hidden />
                  Export
                  <ChevronDown className="size-3.5" aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Alive only</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={aliveRows.length === 0}
                      onClick={() => copyDetailsOf(aliveRows, "alive")}
                    >
                      <Copy className="size-4" aria-hidden />
                      Copy alive details ({counts.alive})
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={aliveRows.length === 0}
                      onClick={() => downloadDetailsOf(aliveRows, "alive-accounts.txt", "alive")}
                    >
                      <FileText className="size-4" aria-hidden />
                      Download alive (.txt) ({counts.alive})
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Dead only</DropdownMenuLabel>
                    <DropdownMenuItem disabled={deadRows.length === 0} onClick={() => copyCookiesOf(deadRows, "dead")}>
                      <Copy className="size-4" aria-hidden />
                      Copy dead cookies ({counts.dead})
                    </DropdownMenuItem>
                    {isNetflix && (
                      <DropdownMenuItem
                        disabled={onHoldRows.length === 0}
                        onClick={() => copyDetailsOf(onHoldRows, "on-hold")}
                      >
                        <CircleAlert className="size-4" aria-hidden />
                        Copy on-hold details ({onHoldRows.length})
                      </DropdownMenuItem>
                    )}
                    {service === "prime" && (
                      <DropdownMenuItem
                        disabled={noPrimeRows.length === 0}
                        onClick={() => copyDetailsOf(noPrimeRows, "no-Prime")}
                      >
                        <CircleAlert className="size-4" aria-hidden />
                        Copy no-Prime details ({noPrimeRows.length})
                      </DropdownMenuItem>
                    )}
                    {service === "crunchyroll" && (
                      <DropdownMenuItem
                        disabled={noSubRows.length === 0}
                        onClick={() => copyDetailsOf(noSubRows, "no-subscription")}
                      >
                        <CircleAlert className="size-4" aria-hidden />
                        Copy no-subscription details ({noSubRows.length})
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Aggregate statistics — no per-row table, just the breakdowns. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="grid gap-5 sm:grid-cols-2">
                {/* Overview */}
                <div className="rounded-md border border-border bg-card p-4 sm:col-span-2">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-foreground">Overview</h3>
                  <div className={`grid grid-cols-2 gap-3 ${isNetflix ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
                    <StatTile
                      label="Alive"
                      value={counts.alive}
                      percent={pct(counts.alive, counts.total)}
                      tone="success"
                    />
                    <StatTile label="Dead" value={counts.dead} percent={pct(counts.dead, counts.total)} tone="muted" />
                    <StatTile
                      label="Errors"
                      value={counts.error}
                      percent={pct(counts.error, counts.total)}
                      tone="destructive"
                    />
                    {/* Extra-member is a Netflix-only metric — hidden for Prime/Crunchyroll. */}
                    {isNetflix && (
                      <StatTile
                        label="Extra Member"
                        value={stats.extraMembers}
                        percent={pct(stats.extraMembers, counts.alive)}
                        tone="muted"
                      />
                    )}
                  </div>
                  <p className="mt-3 font-mono text-[11px] font-bold text-muted-foreground">
                    {/* Email-on-file only applies to Netflix; trimmed services show elapsed only. */}
                    {isNetflix
                      ? `${stats.withEmail} of ${counts.alive} alive accounts have an email on file · ${formatElapsed(elapsedMs)} elapsed`
                      : `${formatElapsed(elapsedMs)} elapsed`}
                  </p>
                </div>

                {/* Plans */}
                <div className="rounded-md border border-border bg-card p-4 ">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-foreground">
                    Plans ({stats.plans.length})
                  </h3>
                  {stats.plans.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {stats.plans.map(([plan, n]) => (
                        <StatBar key={plan} label={plan} value={n} total={counts.alive} />
                      ))}
                    </ul>
                  ) : (
                    <p className="font-mono text-xs text-muted-foreground">No alive accounts.</p>
                  )}
                </div>

                {/* Countries */}
                <div className="rounded-md border border-border bg-card p-4 ">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-foreground">
                    Countries ({stats.countries.length})
                  </h3>
                  {stats.countries.length > 0 ? (
                    <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                      {stats.countries.map(([cc, n]) => (
                        <StatBar key={cc} label={cc} value={n} total={counts.alive} />
                      ))}
                    </ul>
                  ) : (
                    <p className="font-mono text-xs text-muted-foreground">No alive accounts.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              {(counts.dead > 0 || running) && (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-10"
                  disabled={running || counts.dead === 0}
                  onClick={() => recheckDead()}
                >
                  {running ? (
                    <span className="row-spinner" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                  {running ? "Rechecking…" : `Recheck dead (${counts.dead})`}
                </Button>
              )}
              <Button type="button" size="lg" className="h-10" disabled={running} onClick={() => setResultsOpen(false)}>
                <X className="size-4" aria-hidden />
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Virtualized results list: renders only the rows currently in (and just around)
// the viewport, so DOM node count stays constant (~20 rows) regardless of whether
// the run has 1k or 100k cookies. Rows have variable height (alive rows can expand
// a report), so we measure them dynamically via measureElement. This is the key to
// keeping the checker memory-light and lag-free on low-end devices.
function VirtualResultList({
  items,
  service = "netflix",
  linksOnly = false,
}: {
  items: { row: Row; index: number }[]
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  linksOnly?: boolean
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64, // approx collapsed row height; refined by measurement
    overscan: 8,
    getItemKey: (i) => items[i].row.id,
  })

  return (
    <div ref={parentRef} className="max-h-[520px] overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vItem) => {
          const { row, index } = items[vItem.index]
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full border-b border-border last:border-b-0"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <ResultRow row={row} index={index} service={service} linksOnly={linksOnly} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  const display = value === "all" ? "All" : value
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-expanded:bg-primary aria-expanded:text-primary-foreground">
        <span className="font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="font-semibold uppercase text-foreground">{display}</span>
        <ChevronDown className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
        <DropdownMenuItem className="uppercase tracking-wide" onClick={() => onChange("all")}>
          <Check className={value === "all" ? "size-4 opacity-100" : "size-4 opacity-0"} aria-hidden />
          All
        </DropdownMenuItem>
        {options.map((opt) => (
          <DropdownMenuItem key={opt} className="uppercase tracking-wide" onClick={() => onChange(opt)}>
            <Check className={value === opt ? "size-4 opacity-100" : "size-4 opacity-0"} aria-hidden />
            {opt}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Formats a millisecond duration as H:MM:SS (hours dropped when zero) for the
// real-time elapsed clock.
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// Percentage of `value` out of `total`, rounded, guarded against divide-by-zero.
function pct(value: number, total: number): number {
  if (!total) return 0
  return Math.round((value / total) * 100)
}

// A single big-number tile for the modal's Overview grid.
function StatTile({
  label,
  value,
  percent,
  tone,
}: {
  label: string
  value: number
  percent: number
  tone: "success" | "destructive" | "muted"
}) {
  const valueClass =
    tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "text-foreground"
  return (
    <div className="flex flex-col rounded-md border border-border bg-background p-3">
      <span className={`font-mono text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</span>
      <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="mt-0.5 font-mono text-[11px] font-bold text-muted-foreground">{percent}%</span>
    </div>
  )
}

// A labelled horizontal bar showing a breakdown entry (plan or country).
function StatBar({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = pct(value, total)
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 font-mono text-[11px] font-bold">
        <span className="truncate uppercase tracking-wide text-foreground">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {value} · {percent}%
        </span>
      </div>
      <div className="h-2.5 w-full rounded-md border border-border bg-background">
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} aria-hidden />
      </div>
    </li>
  )
}

function SummaryChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Layers
  label: string
  value: number
  tone: "success" | "destructive" | "muted"
}) {
  const toneClasses =
    tone === "success"
      ? "border-foreground bg-success text-white"
      : tone === "destructive"
        ? "border-foreground bg-destructive text-white"
        : "border-foreground bg-card text-muted-foreground"
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest shadow-lg duration-300 animate-in fade-in-0 zoom-in-95 ${toneClasses}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
      <span className="font-semibold">{value}</span>
    </span>
  )
}

// ResultRow is memoized and receives the row object directly. Our row store
// (rowMapRef) preserves object identity for rows that were NOT patched in a
// flush and creates a brand-new object only for rows that changed. So React's
// default shallow prop comparison re-renders exactly the changed rows and skips
// the rest — fast, and (crucially) rows actually update instead of being stuck
// on QUEUED, which happened when we passed only a stable id + getRow.
const ResultRow = memo(function ResultRow({
  row,
  index,
  service = "netflix",
  linksOnly = false,
}: {
  row: Row
  index: number
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  linksOnly?: boolean
}) {
  const r = row.result
  const isAlive = row.status === "alive" && !!r
  const [expanded, setExpanded] = useState(false)
  const panelId = `result-report-${row.id}`
  // Extra-member is a Netflix-only stat; never surface it for Prime/Crunchyroll.
  const isNetflix = service === "netflix"

  return (
    <div className="flex flex-col px-3.5 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index}</span>
          <StatusBadge status={row.status} />
          <span className="truncate font-mono text-xs text-foreground/90" title={row.label}>
            {row.label}
          </span>
        </div>
        <div className="ml-9 flex min-w-0 flex-1 items-center gap-3 sm:ml-0 sm:justify-end">
          {isAlive ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:justify-end">
                {r!.email && <span className="truncate text-foreground">{r!.email}</span>}
                {normalizePlan(r!.plan) && <Pill>{normalizePlan(r!.plan)}</Pill>}
                {isNetflix && r!.extraMember && <Pill>Extra Member</Pill>}
                {r!.countryCode && <Pill>{r!.countryCode}</Pill>}
              </div>
              <CopyRowButton result={r!} cookie={row.raw} service={service} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-label={expanded ? "Hide report" : "Show report"}
                title={expanded ? "Hide report" : "Show report"}
                className="size-7 shrink-0"
              >
                <ChevronDown
                  className={`size-4 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </Button>
            </>
          ) : row.status === "error" ? (
            <p className="truncate text-xs text-destructive sm:text-right">{row.error}</p>
          ) : row.status === "dead" ? (
            <>
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground sm:text-right">
                {r?.message || "Expired or invalid"}
              </p>
              <CopyCookieButton cookie={row.raw} />
            </>
          ) : null}
        </div>
      </div>

      {isAlive && expanded && (
        <div id={panelId} className="mt-3 duration-300 animate-in fade-in-0 slide-in-from-top-1 sm:ml-9">
          <ResultReport result={r!} cookie={row.raw} service={service} hideCookies={linksOnly} />
        </div>
      )}
    </div>
  )
})

function CopyRowButton({
  result,
  cookie,
  service = "netflix",
}: {
  result: CheckResult
  cookie: string
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const details = buildAccountDetails(result, cookie, undefined, service)
    const ok = await copyText(details)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success("Details copied.")
    } else {
      toast.error("Couldn't copy. Try again.")
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={copy}
      aria-label="Copy details"
      title="Copy details"
      className="size-7 shrink-0"
    >
      {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </Button>
  )
}

// Copies the RAW cookie string for a dead/expired row, so it can be re-checked
// elsewhere or saved without re-uploading. Mirrors CopyRowButton's UX.
function CopyCookieButton({ cookie }: { cookie: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const ok = await copyText(cookie)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success("Cookie copied.")
    } else {
      toast.error("Couldn't copy. Try again.")
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={copy}
      aria-label="Copy cookie"
      title="Copy cookie"
      className="size-7 shrink-0"
    >
      {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </Button>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-primary px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-foreground">
      {children}
    </span>
  )
}

function StatusBadge({ status }: { status: RowStatus }) {
  const map = {
    queued: { icon: Clock, label: "Queued", cls: "text-muted-foreground", spin: false },
    checking: { icon: null, label: "Checking", cls: "text-primary", spin: true },
    retrying: { icon: null, label: "Retrying", cls: "text-warning", spin: true },
    alive: { icon: CircleCheck, label: "Alive", cls: "text-success", spin: false },
    dead: { icon: CircleX, label: "Dead", cls: "text-muted-foreground", spin: false },
    error: { icon: CircleAlert, label: "Error", cls: "text-destructive", spin: false },
    stopped: { icon: Square, label: "Stopped", cls: "text-muted-foreground", spin: false },
  } as const
  const { icon: Icon, label, cls, spin } = map[status]
  return (
    <span
      className={`inline-flex w-20 shrink-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest ${cls}`}
    >
      {spin ? <span className="row-spinner" aria-hidden /> : Icon && <Icon className="size-3.5" aria-hidden />}
      {label}
    </span>
  )
}
