"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Trash2,
  RefreshCw,
  Copy,
  Download,
  FileText,
  CircleCheck,
  Inbox,
  Filter,
  ChevronDown,
  Check,
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Layers,
  Globe,
  TriangleAlert,
  ShieldCheck,
  X,
  Rows3,
  Rows2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import type { AdminRole } from "@/lib/admin-auth"
import { copyText, buildAccountDetails, cookieToNetscape, joinAccountDetails, mapChunked, normalizePlan, type CheckResult } from "@/lib/cookie-utils"
import type { SavedCookie } from "@/lib/saved-cookies"
import { BulkChecker, type RecheckSummary } from "@/components/checker/bulk-checker"
import { useMounted } from "@/lib/use-mounted"
import { cn } from "@/lib/utils"
import { formatRelative } from "../shared"

// An account is "stale" if it hasn't been re-verified in this many days. The
// upsert refreshes `updatedAt` on every successful re-check, so a recent recheck
// clears the badge automatically.
const STALE_DAYS = 7
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000
const DENSITY_KEY = "admin:saved:density"

function isStale(s: SavedCookie): boolean {
  const ts = new Date(s.updatedAt).getTime()
  return Number.isFinite(ts) && Date.now() - ts > STALE_MS
}

// Parses a response as JSON without throwing the cryptic "Unexpected token…"
// error when a route returns a plain-text error page (e.g. a function timeout).
async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const snippet = text
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140)
    return { error: snippet || `Request failed (HTTP ${res.status}).` }
  }
}

const fetcher = <T,>(url: string): Promise<T> => fetch(url).then(parseJsonSafe) as Promise<T>

// Dedicated tab that lists every alive account persisted to the Neon database.
// Saving happens in the Checker tab; this view is for browsing, filtering,
// exporting, and pruning the stored accounts. The SWR key is shared with the
// checker so a save there refreshes this list automatically.
export function SavedSection({
  service = "netflix",
  endpoint = "/api/admin/saved-cookies",
  recheckStorageKey = "admin-saved-recheck",
  role = "admin",
}: {
  // Which service these saved accounts belong to. Drives the recheck engine's
  // target ("prime" re-validates against Amazon Prime, "crunchyroll" against
  // Crunchyroll) and the prompt copy.
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  // The admin saved-cookies API this view reads/deletes against. Defaults to the
  // Netflix pool; the Prime/Crunchyroll Saved tabs pass their own endpoint.
  endpoint?: string
  // Namespaces the embedded recheck run so each service's recheck doesn't share
  // a saved-progress snapshot.
  recheckStorageKey?: string
  role?: AdminRole
} = {}) {
  const serviceLabel =
    service === "prime"
      ? "Prime"
      : service === "crunchyroll"
        ? "Crunchyroll"
        : service === "steam"
          ? "Steam"
          : service === "spotify"
            ? "Spotify"
            : "Netflix"
  const { data, isLoading, mutate } = useSWR<{ items: SavedCookie[] }>(endpoint, fetcher, {
    revalidateOnFocus: false,
  })
  const saved = (data?.items as SavedCookie[] | undefined) ?? []
  const mounted = useMounted()
  const confirm = useConfirm()

  const [query, setQuery] = useState("")
  const [planFilter, setPlanFilter] = useState("all")
  const [countryFilter, setCountryFilter] = useState("all")
  const [staleOnly, setStaleOnly] = useState(false)
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(50)

  // Multi-select for bulk actions. Holds DB ids; survives filter/page changes.
  const isModerator = role === "moderator"
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Row density — persisted so the admin's preference sticks across reloads.
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable")
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(DENSITY_KEY) : null
    if (saved === "compact" || saved === "comfortable") setDensity(saved)
  }, [])
  function changeDensity(next: "comfortable" | "compact") {
    setDensity(next)
    try {
      window.localStorage.setItem(DENSITY_KEY, next)
    } catch {
      /* ignore quota / disabled storage */
    }
  }

  // ----- Fast client-side recheck (the SAME engine as the public Bulk checker) --
  // The interactive recheck embeds the BulkChecker in recheck mode, seeded with
  // either ALL saved accounts or just the SELECTED ones. Bumping `seedSignal`
  // (re)loads the seed and auto-starts a fast, proxy-backed run; expired accounts
  // it finds are deleted in one batch request when it completes.
  const [seedSignal, setSeedSignal] = useState(0)
  // null = recheck everything; otherwise the explicit id subset to recheck.
  const [recheckIds, setRecheckIds] = useState<string[] | null>(null)
  // The list view omits cookie blobs (they're fetched on demand), so only rows whose
  // cookie has been hydrated can seed a recheck. startRecheck() hydrates the target
  // set before bumping seedSignal, so by the time this runs the cookies are present;
  // the `.filter` is a safety net that drops any row still missing its cookie.
  const seedRows = useMemo(() => {
    const source = recheckIds ? saved.filter((s) => recheckIds.includes(s.id)) : saved
    return source.filter((s) => s.cookie).map((s) => ({ key: s.id, cookie: s.cookie, label: s.email ?? undefined }))
  }, [saved, recheckIds])

  // Live progress mirrored from the embedded recheck engine, surfaced in a
  // prominent banner at the top of this section so the admin always sees that a
  // recheck is running, how far along it is, and when it finished.
  type RecheckPhase = "idle" | "running" | "done"
  type RecheckLive = { total: number; done: number; alive: number; dead: number; error: number; progress: number }
  const [recheckPhase, setRecheckPhase] = useState<RecheckPhase>("idle")
  const [recheckLive, setRecheckLive] = useState<RecheckLive | null>(null)
  // The finished summary (also tells us how many expired were actually removed).
  const [recheckDone, setRecheckDone] = useState<{
    alive: number
    removed: number
    errored: number
    kept: number
  } | null>(null)
  const recheckPanelRef = useRef<HTMLDivElement | null>(null)

  function handleRecheckState(state: {
    running: boolean
    paused: boolean
    preparing: boolean
    total: number
    done: number
    alive: number
    dead: number
    error: number
    progress: number
  }) {
    if (state.running || state.preparing || state.paused) {
      setRecheckPhase("running")
      setRecheckDone(null)
    }
    setRecheckLive({
      total: state.total,
      done: state.done,
      alive: state.alive,
      dead: state.dead,
      error: state.error,
      progress: state.progress,
    })
  }

  async function handleRecheckComplete(summary: RecheckSummary) {
    const dead = summary.dead
    setRecheckPhase("done")

    // Nothing expired — keep everything, just refresh.
    if (dead.length === 0) {
      setRecheckDone({
        alive: summary.alive.length,
        removed: 0,
        errored: summary.errored.length,
        kept: summary.alive.length,
      })
      toast.success(
        summary.errored.length > 0
          ? `Recheck complete · ${summary.alive.length} alive · none expired · ${summary.errored.length} couldn't be verified (kept).`
          : `Recheck complete · ${summary.alive.length} still alive · none expired.`,
      )
      await mutate()
      return
    }

    // SAFETY GUARD against false-positive deletion. Accounts that errored (proxy
    // block, timeout, rate-limit) are NEVER treated as dead — they're kept. And we
    // require an explicit confirmation before removing the expired ones, surfacing
    // exactly what will be deleted vs kept, so a Netflix block wave can never
    // silently wipe still-valid accounts.
    const ok = await confirm({
      title: `Remove ${dead.length} expired account${dead.length === 1 ? "" : "s"}?`,
      description:
        `${summary.alive.length} still alive (kept) · ${dead.length} confirmed expired (will be deleted)` +
        (summary.errored.length > 0 ? ` · ${summary.errored.length} couldn't be verified — kept, not deleted.` : "."),
      confirmLabel: `Delete ${dead.length} expired`,
      destructive: true,
    })

    if (!ok) {
      setRecheckDone({
        alive: summary.alive.length,
        removed: 0,
        errored: summary.errored.length,
        kept: summary.alive.length + dead.length,
      })
      toast.info("Kept all accounts — nothing was deleted.")
      await mutate()
      return
    }

    try {
      const res = await fetch(endpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: dead }),
      })
      const json = await parseJsonSafe(res)
      if (!res.ok) throw new Error((json.error as string) || "Couldn't delete expired accounts.")
      setRecheckDone({
        alive: summary.alive.length,
        removed: dead.length,
        errored: summary.errored.length,
        kept: summary.alive.length,
      })
      toast.success(`Recheck complete · ${summary.alive.length} alive · deleted ${dead.length} expired.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete expired accounts.")
    } finally {
      await mutate()
    }
  }

  // Filter option lists derived from the saved set.
  const planOptions = useMemo(
    () => Array.from(new Set(saved.map((s) => normalizePlan(s.plan)).filter((v): v is string => !!v))).sort(),
    [saved],
  )
  const countryOptions = useMemo(
    () => Array.from(new Set(saved.map((s) => s.countryCode).filter((v): v is string => !!v))).sort(),
    [saved],
  )

  // The current filtered view. Search matches the account email. (Raw cookie-string
  // matching was removed: cookie blobs are no longer loaded into the list — they're
  // fetched on demand — so there's nothing client-side to substring-match against.)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return saved.filter(
      (s) =>
        (planFilter === "all" || normalizePlan(s.plan) === planFilter) &&
        (countryFilter === "all" || s.countryCode === countryFilter) &&
        (!staleOnly || isStale(s)) &&
        (q === "" || (s.email ?? "").toLowerCase().includes(q)),
    )
  }, [saved, query, planFilter, countryFilter, staleOnly])

  const filtersActive = query.trim() !== "" || planFilter !== "all" || countryFilter !== "all" || staleOnly

  // Pagination — 100 rows per page over the current filtered view. This caps the
  // number of rendered DOM rows regardless of pool size (the same protection a
  // virtualized list would give), so the table stays fast at thousands of rows.
  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPerPage))
  const safePage = Math.min(page, pageCount - 1)
  useEffect(() => {
    setPage(0)
  }, [query, planFilter, countryFilter, staleOnly, rowsPerPage])
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])
  const pageStart = safePage * rowsPerPage
  const pageItems = filtered.slice(pageStart, pageStart + rowsPerPage)

  // ----- Selection helpers -----
  const selectedRows = useMemo(() => saved.filter((s) => selected.has(s.id)), [saved, selected])
  const allPageSelected = pageItems.length > 0 && pageItems.every((s) => selected.has(s.id))
  const somePageSelected = pageItems.some((s) => selected.has(s.id))

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleAllPage() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allPageSelected) pageItems.forEach((s) => next.delete(s.id))
      else pageItems.forEach((s) => next.add(s.id))
      return next
    })
  }
  function clearSelection() {
    setSelected(new Set())
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success("Removed saved account.")
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await mutate()
    } catch {
      toast.error("Couldn't remove that entry.")
    }
  }

  async function clearAll() {
    if (saved.length === 0) return
    const ok = await confirm({
      title: "Clear all saved accounts",
      description: `Delete all ${saved.length} saved accounts? This cannot be undone.`,
      confirmLabel: "Delete all",
      destructive: true,
    })
    if (!ok) return
    try {
      const res = await fetch(`${endpoint}?all=true`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      toast.success("Cleared all saved accounts.")
      clearSelection()
      await mutate()
    } catch {
      toast.error("Couldn't clear saved accounts.")
    }
  }

  // Bulk-delete the currently selected accounts in one request.
  async function deleteSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirm({
      title: `Delete ${ids.length} selected account${ids.length === 1 ? "" : "s"}`,
      description: "This permanently removes the selected accounts. This cannot be undone.",
      confirmLabel: "Delete selected",
      destructive: true,
    })
    if (!ok) return
    try {
      const res = await fetch(endpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const json = await parseJsonSafe(res)
      if (!res.ok) throw new Error((json.error as string) || "Delete failed.")
      toast.success(`Deleted ${ids.length} account(s).`)
      clearSelection()
      await mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete the selected accounts.")
    }
  }

  // On-demand cookie hydration. The list view omits cookie blobs to keep data
  // transfer tiny even with thousands of saved accounts; whenever an action actually
  // needs the raw cookies (copy / download / recheck) we fetch just the required ids
  // here, splice them into the SWR cache (so the recheck seed, the table, and any
  // follow-up action see them without re-fetching), and return hydrated copies for
  // the caller to use immediately. Ids already carrying a cookie are skipped.
  async function ensureCookies(list: SavedCookie[]): Promise<SavedCookie[]> {
    const missing = Array.from(new Set(list.filter((s) => !s.cookie).map((s) => s.id)))
    if (missing.length === 0) return list
    const map = new Map<string, string>()
    // Chunk so the query string can't grow unbounded on huge selections.
    const CHUNK = 200
    for (let i = 0; i < missing.length; i += CHUNK) {
      const ids = missing.slice(i, i + CHUNK)
      const res = await fetch(`${endpoint}?cookies=${encodeURIComponent(ids.join(","))}`)
      const json = (await parseJsonSafe(res)) as { cookies?: { id: string; cookie: string }[] }
      for (const c of json.cookies ?? []) map.set(c.id, c.cookie)
    }
    if (map.size > 0) {
      // Hydrate the SWR cache in place (no revalidation) so seedRows / display / later
      // actions read the fetched cookies without another round-trip.
      mutate(
        (prev) =>
          prev ? { items: prev.items.map((it) => (map.has(it.id) ? { ...it, cookie: map.get(it.id)! } : it)) } : prev,
        { revalidate: false },
      )
    }
    return list.map((s) => (map.has(s.id) ? { ...s, cookie: map.get(s.id)! } : s))
  }

  // Kick off a recheck of either ALL or a specific id subset. We hydrate the cookies
  // for the target set FIRST (the list omits them), then bump the signal so the
  // embedded checker reads a seedRows that already has cookies.
  async function startRecheck(ids: string[] | null) {
    const count = ids ? ids.length : saved.length
    if (count === 0) return toast.info("No saved accounts to recheck.")
    const ok = await confirm({
      title: ids ? `Recheck ${count} selected account${count === 1 ? "" : "s"}` : "Recheck all saved accounts",
      // Deletion is confirmed separately at the END, once we know exactly which
      // accounts came back expired — so this prompt only starts the run.
      description: `Re-validate ${count} account${count === 1 ? "" : "s"} against ${serviceLabel}? You'll confirm any removals after it finishes.`,
      confirmLabel: "Recheck",
    })
    if (!ok) return
    setRecheckPhase("running")
    setRecheckDone(null)
    setRecheckLive(null)
    // Fetch the raw cookies for the accounts being rechecked so seedRows can seed the
    // checker. This is the one place a large batch of cookies is pulled — but it's an
    // explicit operator action, and rechecking inherently needs every target cookie.
    try {
      const source = ids ? saved.filter((s) => ids.includes(s.id)) : saved
      await ensureCookies(source)
    } catch {
      toast.error("Couldn't load cookies for the recheck.")
      setRecheckPhase("idle")
      return
    }
    setRecheckIds(ids)
    setSeedSignal((n) => n + 1)
    // Bring the live recheck panel into view so progress is immediately visible
    // even when the toolbar button is far above it.
    requestAnimationFrame(() => recheckPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  // Export helpers operate on whatever list they're handed (all/filtered/selected).
  // Each hydrates the raw cookies on demand first (the list omits them).
  // Builds the joined details for a hydrated list off the main thread (chunked +
  // yielding) so exporting thousands of saved accounts never freezes the tab, with
  // a live progress toast for large lists.
  async function buildSavedDetails(hydrated: SavedCookie[], verb: string, label: string): Promise<string> {
    let toastId: string | number | undefined
    const blocks = await mapChunked(
      hydrated,
      (s, i) => buildAccountDetails(toResult(s), s.cookie, { index: i + 1, total: hydrated.length }, service),
      {
        onProgress: (done, total) => {
          if (total < 400) return
          const pct = Math.round((done / total) * 100)
          const msg = `${verb} ${label}… ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)`
          toastId = toast.loading(msg, toastId === undefined ? undefined : { id: toastId })
        },
      },
    )
    if (toastId !== undefined) toast.dismiss(toastId)
    return joinAccountDetails(blocks)
  }

  async function copyDetailsOf(list: SavedCookie[], label: string) {
    if (list.length === 0) return toast.info(`No ${label} accounts to copy.`)
    const hydrated = await ensureCookies(list)
    const text = await buildSavedDetails(hydrated, "Preparing", label)
    const ok = await copyText(text)
    ok ? toast.success(`Copied ${hydrated.length.toLocaleString()} account(s).`) : toast.error("Couldn't copy.")
  }

  // Downloads the SAME human-readable details text that "Copy details" produces,
  // as a plain .txt file (the only download format we offer now).
  async function downloadDetailsOf(list: SavedCookie[], filename: string, label: string) {
    if (list.length === 0) return toast.info(`No ${label} accounts to export.`)
    const hydrated = await ensureCookies(list)
    const text = await buildSavedDetails(hydrated, "Preparing", label)
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${hydrated.length} account(s).`)
  }

  const cellPad = density === "compact" ? "px-3 py-1.5" : "px-3 py-2.5"

  return (
    <section className="flex flex-col gap-4 rounded-md glass p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CircleCheck className="size-4 text-success" aria-hidden />
          <h2 className="text-base font-semibold uppercase tracking-widest text-foreground">
            {serviceLabel} Saved Alive
          </h2>
          <span className="rounded-md border border-border bg-card px-2.5 py-0.5 font-mono text-xs font-bold text-foreground">
            {saved.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => mutate()} disabled={isLoading}>
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => startRecheck(null)}
            disabled={isModerator || saved.length === 0}
          >
            <RotateCcw className="size-4" aria-hidden />
            Recheck all
          </Button>

          {!isModerator && <> {/* Export dropdown — administrator only. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={saved.length === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3.5 text-sm font-bold text-foreground transition-all duration-75 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-primary aria-expanded:text-primary-foreground"
            >
              <Download className="size-4" aria-hidden />
              Export
              <ChevronDown className="size-3.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>All — {saved.length}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => copyDetailsOf(saved, "saved")}>
                  <Copy className="size-4" aria-hidden />
                  Copy all details ({saved.length})
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadDetailsOf(saved, "saved-alive.txt", "saved")}>
                  <FileText className="size-4" aria-hidden />
                  Download all (.txt)
                </DropdownMenuItem>
              </DropdownMenuGroup>
              {/* Filtered group only appears once a search/filter is applied. */}
              {filtersActive && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Filtered — {filtered.length} shown</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={filtered.length === 0}
                      onClick={() => copyDetailsOf(filtered, "filtered")}
                    >
                      <Copy className="size-4" aria-hidden />
                      Copy filtered details ({filtered.length})
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={filtered.length === 0}
                      onClick={() => downloadDetailsOf(filtered, "saved-filtered.txt", "filtered")}
                    >
                      <FileText className="size-4" aria-hidden />
                      Download filtered (.txt)
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          </>}

          {!isModerator && <Button type="button" variant="destructive" size="sm" onClick={clearAll} disabled={saved.length === 0}>
            <Trash2 className="size-4" aria-hidden />
            Clear
          </Button>}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {"// every alive account is stored once — re-checking the same account refreshes it instead of duplicating."}
      </p>

      {/* Stat cards — pool composition at a glance. */}
      {saved.length > 0 && <SavedStats saved={saved} />}

      {/* Fast recheck — embeds the SAME engine the public Bulk checker uses, seeded
 with all saved or just the selected accounts. Mounted once a recheck is
 started; shows live progress + Pause/Stop, and deletes expired accounts
 when it finishes. */}
      <div ref={recheckPanelRef}>
        {/* Always-visible recheck status banner: running progress + final summary,
 so the admin can see at a glance that a recheck is in flight or done. */}
        {recheckPhase !== "idle" && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 flex flex-col gap-2 rounded-md border border-border bg-card p-4 "
          >
            <div className="flex flex-wrap items-center gap-2">
              {recheckPhase === "running" ? (
                <RotateCcw className="size-4 animate-spin text-foreground" aria-hidden />
              ) : (
                <ShieldCheck className="size-4 text-success" aria-hidden />
              )}
              <span className="text-sm font-semibold uppercase tracking-widest text-foreground">
                {recheckPhase === "running" ? "Rechecking saved accounts…" : "Recheck complete"}
              </span>
              {recheckLive && recheckPhase === "running" && (
                <span className="ml-auto font-mono text-xs font-bold text-muted-foreground">
                  {recheckLive.done}/{recheckLive.total} checked
                </span>
              )}
            </div>

            {recheckPhase === "running" && recheckLive && (
              <>
                <div className="h-3 w-full overflow-hidden rounded-md border border-border bg-card">
                  <div
                    className="h-full rounded-md bg-accent transition-[width] duration-500 ease-out"
                    style={{ width: `${recheckLive.progress}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs font-bold text-muted-foreground">
                  <span className="text-success">{recheckLive.alive} alive</span>
                  <span>{recheckLive.dead} expired</span>
                  {recheckLive.error > 0 && <span className="text-destructive">{recheckLive.error} unverified</span>}
                </div>
              </>
            )}

            {recheckPhase === "done" && recheckDone && (
              <p className="font-mono text-xs font-bold text-muted-foreground">
                <span className="text-success">{recheckDone.alive} alive</span>
                {" · "}
                {recheckDone.removed > 0 ? `${recheckDone.removed} expired removed` : "none removed"}
                {recheckDone.errored > 0 && (
                  <span className="text-destructive">{` · ${recheckDone.errored} unverified (kept)`}</span>
                )}
              </p>
            )}
          </div>
        )}

        {seedSignal > 0 && (
          <BulkChecker
            recheckMode
            isAdmin
            service={service}
            storageKey={recheckStorageKey}
            seedRows={seedRows}
            seedSignal={seedSignal}
            onRunStateChange={handleRecheckState}
            onRunComplete={handleRecheckComplete}
          />
        )}
      </div>

      {/* Filters + density toggle */}
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <Filter className="size-3.5" aria-hidden />
            Filters
          </span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email…"
              aria-label="Search saved accounts by email"
              className="h-8 w-44 rounded-md border border-border bg-card pl-8 pr-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          <FilterSelect label="Plan" value={planFilter} options={planOptions} onChange={setPlanFilter} />
          <FilterSelect label="Country" value={countryFilter} options={countryOptions} onChange={setCountryFilter} />
          {/* Stale-only toggle */}
          <button
            type="button"
            onClick={() => setStaleOnly((v) => !v)}
            aria-pressed={staleOnly}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-bold uppercase tracking-wide outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              staleOnly ? "bg-warning text-foreground" : "bg-card text-muted-foreground hover:bg-muted",
            )}
          >
            <TriangleAlert className="size-3.5" aria-hidden />
            Stale
          </button>
          {filtersActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("")
                setPlanFilter("all")
                setCountryFilter("all")
                setStaleOnly(false)
              }}
            >
              Reset
            </Button>
          )}

          {/* Density toggle — segmented control, pushed to the right. */}
          <div className="ml-auto inline-flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Showing {filtered.length} of {saved.length}
            </span>
            <div
              className="inline-flex items-center rounded-md border border-border"
              role="group"
              aria-label="Row density"
            >
              <button
                type="button"
                onClick={() => changeDensity("comfortable")}
                aria-pressed={density === "comfortable"}
                title="Comfortable rows"
                className={cn(
                  "inline-flex size-7 items-center justify-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  density === "comfortable"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                <Rows3 className="size-3.5" aria-hidden />
                <span className="sr-only">Comfortable</span>
              </button>
              <button
                type="button"
                onClick={() => changeDensity("compact")}
                aria-pressed={density === "compact"}
                title="Compact rows"
                className={cn(
                  "inline-flex size-7 items-center justify-center border-l border-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  density === "compact"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                <Rows2 className="size-3.5" aria-hidden />
                <span className="sr-only">Compact</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk-action bar — appears when at least one row is selected. */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent/15 px-3 py-2 ">
          <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-foreground">
            <Check className="size-3.5" aria-hidden />
            {selected.size} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => copyDetailsOf(selectedRows, "selected")}>
              <Copy className="size-4" aria-hidden />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadDetailsOf(selectedRows, "saved-selected.txt", "selected")}
            >
              <FileText className="size-4" aria-hidden />
              Export
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => startRecheck([...selected])}>
              <ShieldCheck className="size-4" aria-hidden />
              Re-verify
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={deleteSelected}>
              <Trash2 className="size-4" aria-hidden />
              Delete
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>
              <X className="size-4" aria-hidden />
              Clear
            </Button>
          </div>
        </div>
      )}

      {saved.length === 0 ? (
        isLoading ? (
          <SavedTableSkeleton />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card py-12 text-center">
            <Inbox className="size-7 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">
              No alive accounts saved yet. Run a check in the Checker tab to populate this.
            </p>
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card py-12 text-center">
          <Inbox className="size-7 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-muted-foreground">No saved accounts match the current filters.</p>
        </div>
      ) : (
        <div className="max-h-[640px] overflow-auto rounded-md border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                <th className="w-10 px-3 py-2.5">
                  {!isModerator && <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allPageSelected && somePageSelected
                    }}
                    onChange={toggleAllPage}
                    aria-label="Select all accounts on this page"
                    className="size-3.5 cursor-pointer accent-primary"
                  />}
                </th>
                <th className="px-3 py-2.5 font-semibold">Email</th>
                <th className="px-3 py-2.5 font-semibold">Plan</th>
                <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">Country</th>
                <th className="px-3 py-2.5 font-semibold">Saved</th>
                <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pageItems.map((s) => {
                const stale = isStale(s)
                const isSel = selected.has(s.id)
                return (
                  <tr
                    key={s.id}
                    className={cn("text-foreground transition-colors hover:bg-muted", isSel && "bg-primary/10")}
                  >
                    <td className={cellPad}>
                      {!isModerator && <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleOne(s.id)}
                        aria-label={`Select ${s.email ?? "account"}`}
                        className="size-3.5 cursor-pointer accent-primary"
                      />}
                    </td>
                    <td
                      className={cn("max-w-[220px] truncate font-mono", cellPad)}
                      title={s.email ?? `account #${s.id}`}
                    >
                      {s.email ?? <span className="text-muted-foreground">account #{s.id}</span>}
                    </td>
                    <td className={cellPad}>
                      {normalizePlan(s.plan) ? (
                        <span className="rounded-md border border-border bg-primary px-2 py-0.5 text-[11px] font-semibold uppercase text-primary-foreground">
                          {normalizePlan(s.plan)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={cn("hidden sm:table-cell", cellPad)}>{s.countryCode ?? "—"}</td>
                    <td className={cellPad}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-muted-foreground">
                          {mounted ? formatRelative(new Date(s.createdAt).getTime()) : "—"}
                        </span>
                        {mounted && stale && (
                          <span
                            title={`Not re-checked in over ${STALE_DAYS} days`}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-warning px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground"
                          >
                            <TriangleAlert className="size-3" aria-hidden />
                            Stale
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={cellPad}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => void copyOne(s, endpoint, service)}
                          aria-label="Copy details"
                          title="Copy details"
                        >
                          <Copy className="size-3.5" aria-hidden />
                        </Button>
                    {!isModerator && <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => void remove(s.id)}
                      aria-label="Delete saved account"
                      title="Delete saved account"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {`Showing ${(pageStart + 1).toLocaleString()}–${(pageStart + pageItems.length).toLocaleString()} of ${filtered.length.toLocaleString()}`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rows
              <select
                value={rowsPerPage}
                onChange={(e) => setRowsPerPage(Number(e.target.value))}
                aria-label="Rows per page"
                className="h-8 rounded-md border border-border bg-card px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {[25, 50, 100, 250].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            {pageCount > 1 && (
              <div className="flex items-center gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page">First</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} aria-label="Previous page">
                  <ChevronLeft className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">Prev</span>
                </Button>
                <span className="min-w-16 text-center font-mono text-xs text-muted-foreground" aria-live="polite">
                  {safePage + 1} / {pageCount}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} aria-label="Next page">
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="size-3.5" aria-hidden />
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} aria-label="Last page">Last</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ----- Stat cards: pool composition (plans, countries, stale, totals) -----
function SavedStats({ saved }: { saved: SavedCookie[] }) {
  const stats = useMemo(() => {
    const planCounts = new Map<string, number>()
    const countryCounts = new Map<string, number>()
    let withEmail = 0
    let stale = 0
    for (const s of saved) {
      const plan = normalizePlan(s.plan) ?? "Unknown"
      planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1)
      const cc = s.countryCode ?? "—"
      countryCounts.set(cc, (countryCounts.get(cc) ?? 0) + 1)
      if (s.email) withEmail++
      if (isStale(s)) stale++
    }
    const byPlan = [...planCounts.entries()].sort((a, b) => b[1] - a[1])
    const byCountry = [...countryCounts.entries()].sort((a, b) => b[1] - a[1])
    return { byPlan, byCountry, withEmail, stale, planCount: planCounts.size, countryCount: countryCounts.size }
  }, [saved])

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={CircleCheck}
          label="Total alive"
          value={saved.length.toLocaleString()}
          sub={`${stats.withEmail} with email`}
          tone="success"
        />
        <StatCard
          icon={Layers}
          label="Plans"
          value={String(stats.planCount)}
          sub={stats.byPlan[0] ? `Top: ${stats.byPlan[0][0]}` : undefined}
        />
        <StatCard
          icon={Globe}
          label="Countries"
          value={String(stats.countryCount)}
          sub={stats.byCountry[0] ? `Top: ${stats.byCountry[0][0]}` : undefined}
          tone="info"
        />
        <StatCard
          icon={TriangleAlert}
          label="Stale"
          value={stats.stale.toLocaleString()}
          sub={`Not checked in ${STALE_DAYS}d`}
          tone={stats.stale > 0 ? "warning" : "default"}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <BreakdownCard icon={Layers} title="By plan" rows={stats.byPlan} total={saved.length} />
        <BreakdownCard icon={Globe} title="By country" rows={stats.byCountry.slice(0, 8)} total={saved.length} />
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  tone?: "default" | "success" | "warning" | "info"
}) {
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "info"
          ? "text-info"
          : "text-foreground"
  return (
    <div className="rounded-md border border-border bg-card p-4 ">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={cn("size-4", toneCls)} aria-hidden />
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums", toneCls)}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function BreakdownCard({
  icon: Icon,
  title,
  rows,
  total,
}: {
  icon: React.ElementType
  title: string
  rows: [string, number][]
  total: number
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4 ">
      <p className="mb-3 inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">No data.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(([label, value]) => {
            const p = total > 0 ? Math.round((value / total) * 100) : 0
            return (
              <div key={label} className="flex items-center gap-2">
                <span
                  className="w-20 shrink-0 truncate font-mono text-[11px] font-bold uppercase text-foreground"
                  title={label}
                >
                  {label}
                </span>
                <span className="relative h-4 flex-1 overflow-hidden border border-border bg-muted">
                  <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${p}%` }} aria-hidden />
                </span>
                <span className="w-12 text-right font-mono text-[11px] font-bold tabular-nums text-foreground">
                  {value}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Skeleton shown while the first load of saved accounts is in flight.
function SavedTableSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card p-4" aria-hidden>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="size-3.5 shrink-0 animate-pulse bg-muted" />
            <div className="h-4 flex-1 animate-pulse bg-muted" />
            <div className="h-4 w-16 animate-pulse bg-muted" />
            <div className="h-4 w-10 animate-pulse bg-muted" />
            <div className="h-4 w-20 animate-pulse bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}

// Compact dropdown filter, matching the main bulk-checker's FilterSelect.
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

// Rebuilds a CheckResult-shaped object from a stored row for detail formatting.
function toResult(s: SavedCookie): CheckResult {
  return {
    valid: true,
    email: s.email ?? undefined,
    plan: normalizePlan(s.plan),
    countryCode: s.countryCode ?? undefined,
    paymentMethod: s.paymentMethod ?? undefined,
    nextBillingCycle: s.nextBillingCycle ?? undefined,
    memberSince: s.memberSince ?? undefined,
    phone: s.phone ?? undefined,
    maxStreams: s.maxStreams ?? undefined,
    emailVerified: s.emailVerified ?? undefined,
    profiles: s.profiles ?? undefined,
    links: s.links ?? undefined,
  }
}

// Copies a single account's details. The list view omits cookie blobs, so when the
// row's cookie isn't present we fetch just that one on demand from the admin endpoint.
async function copyOne(
  s: SavedCookie,
  endpoint: string,
  service: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" = "netflix",
) {
  let cookie = s.cookie
  if (!cookie) {
    try {
      const res = await fetch(`${endpoint}?cookies=${encodeURIComponent(s.id)}`)
      const json = (await res.json().catch(() => ({}))) as { cookies?: { id: string; cookie: string }[] }
      cookie = json.cookies?.[0]?.cookie ?? ""
    } catch {
      /* fall through to the empty-cookie guard below */
    }
  }
  if (!cookie) return toast.error("Couldn't load the cookie.")
  const exportValue = service === "prime" ? cookieToNetscape(cookie, "prime") : buildAccountDetails(toResult(s), cookie, undefined, service)
  const ok = await copyText(exportValue)
  ok ? toast.success(service === "prime" ? "Netscape cookies copied." : "Details copied.") : toast.error("Couldn't copy.")
}
