"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  LayoutDashboard,
  BarChart3,
  ListChecks,
  ServerCog,
  LogOut,
  RefreshCw,
  Terminal,
  Database,
  ShieldCheck,
  ShieldHalf,
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Loader2,
  Pause,
  Tv,
  KeyRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmProvider } from "@/components/ui/confirm-dialog"
import { BulkRunStatusProvider, useBulkRunStatus } from "@/components/admin/bulk-run-status"
import { cn } from "@/lib/utils"
import { useAdminMetrics, type AdminData } from "@/lib/use-admin-metrics"
import { useMounted } from "@/lib/use-mounted"
import { CHECKER_SECTIONS, type SectionId } from "@/lib/admin-sections"
import type { AdminRole } from "@/lib/admin-auth"
import { StatusDot, formatClock } from "./shared"
import { OverviewSection } from "./sections/overview-section"
import { AnalyticsSection } from "./sections/analytics-section"
import { ActivitySection } from "./sections/activity-section"
import { SystemSection } from "./sections/system-section"
import { CheckerSection } from "./sections/checker-section"
import { SavedSection } from "./sections/saved-section"
import { AccessCodesSection } from "./access-codes-section"

type CheckerMode = "single" | "bulk"

const NAV: { id: SectionId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "checker", label: "Netflix Checker", icon: ShieldCheck },
  { id: "saved", label: "Netflix Saved", icon: Bookmark },
  { id: "prime-checker", label: "Prime Checker", icon: ShieldHalf },
  { id: "prime-saved", label: "Prime Saved", icon: BookmarkCheck },
  { id: "crunchyroll-checker", label: "Crunchyroll Checker", icon: Tv },
  { id: "crunchyroll-saved", label: "Crunchyroll Saved", icon: BookmarkPlus },
  { id: "spotify-checker", label: "Spotify Checker", icon: Database },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "activity", label: "Activity", icon: ListChecks },
  { id: "system", label: "System", icon: ServerCog },
  { id: "access-codes", label: "Access Codes", icon: KeyRound },
]

// Builds the clean admin path for a section: overview lives at the bare /admin,
// every other section at /admin/<id> (checker bulk mode appends /bulk separately,
// owned by the embedded CheckerShell).
function sectionUrl(id: SectionId): string {
  return id === "overview" ? "/admin" : `/admin/${id}`
}

export function AdminPanel({
  initialData,
  initialSection = "overview",
  initialCheckerMode = "single",
  role = "admin",
}: {
  initialData: AdminData
  // Section + checker mode are resolved from the URL path on the SERVER and passed
  // in, so the correct section is server-rendered on first paint (no flash/restore).
  initialSection?: SectionId
  initialCheckerMode?: CheckerMode
  role?: AdminRole
}) {
  const router = useRouter()
  const [section, setSection] = useState<SectionId>(initialSection)
  const { data, isRefreshing, refresh } = useAdminMetrics(initialData)
  const mounted = useMounted()

  // Selecting a tab writes the clean path URL (replaceState — no new history entry,
  // no navigation/remount) so the choice survives a reload and is shareable. For a
  // checker section we DON'T write here: the now-active CheckerShell owns its URL
  // (it appends /bulk for bulk mode) and re-syncs it when it becomes visible.
  const selectSection = useCallback((id: SectionId) => {
    setSection(id)
    if (!CHECKER_SECTIONS.includes(id)) window.history.replaceState(null, "", sectionUrl(id))
  }, [])

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" })
    router.replace("/admin/login")
    router.refresh()
  }

  const redisState = data.system.redis.state
  const visibleNav = role === "moderator" ? NAV.filter((item) => ["checker", "saved", "prime-checker", "prime-saved", "crunchyroll-checker", "crunchyroll-saved", "spotify-checker"].includes(item.id)) : NAV
  const liveLabel = visibleNav.find((n) => n.id === section)?.label ?? "Checker"
  const isModerator = role === "moderator"

  return (
    <ConfirmProvider>
      <BulkRunStatusProvider>
        <div className="min-h-screen md:grid md:grid-cols-[14rem_1fr]">
          {/* Sidebar — pinned to the viewport from tablet up so it never grows with the
 page content or produces its own scrollbar; the nav is sized to always fit
 (no internal scroll) while the main column scrolls independently. */}
          <aside className="hidden border-r border-border bg-card md:sticky md:top-0 md:flex md:h-svh md:flex-col md:overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-primary text-primary-foreground ">
                <Terminal className="size-4.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">Admin Panel</p>
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Cookie Checker
                </p>
              </div>
            </div>
            {/* min-h-0 lets this flex child shrink so the footer stays pinned; the nav
 itself never scrolls — items are compact enough to always fit. */}
            <nav className="flex min-h-0 flex-1 flex-col gap-1 p-2.5" aria-label="Admin sections">
              {visibleNav.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectSection(item.id)}
                  aria-current={section === item.id ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md border px-3 py-1.5 text-[13px] font-bold transition-all duration-75",
                    section === item.id
                      ? "border-foreground bg-primary text-primary-foreground "
                      : "border-transparent text-muted-foreground hover:border-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="border-t border-border p-3">
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Database className="size-3.5" aria-hidden />
                <StatusDot state={redisState} pulse />
                <span>{data.system.redis.label}</span>
              </div>
              <Button type="button" variant="outline" size="sm" className="mt-2 w-full justify-start" onClick={logout}>
                <LogOut className="size-4" aria-hidden />
                Sign out
              </Button>
            </div>
          </aside>

          {/* Main */}
          <div className="flex min-h-screen flex-col">
            <header className="sticky top-0 z-10 border-b border-border bg-background">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                <div>
                  <h1 className="text-lg font-semibold uppercase tracking-tight text-foreground">{liveLabel}</h1>
                  <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <StatusDot state="ok" pulse />
                    Live{mounted ? ` · updated ${formatClock(data.generatedAt)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <BulkRunPill onJump={() => selectSection("checker")} />
                  <Button type="button" variant="outline" size="sm" onClick={() => refresh()} disabled={isRefreshing}>
                    <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} aria-hidden />
                    Refresh
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="md:hidden" onClick={logout}>
                    <LogOut className="size-4" aria-hidden />
                    <span className="sr-only">Sign out</span>
                  </Button>
                </div>
              </div>
              {/* Mobile nav — horizontal scroll strip, phones only (tablet+ uses the fixed sidebar) */}
              <nav
                className="flex gap-1.5 overflow-x-auto border-t border-border px-2 py-2 no-scrollbar md:hidden"
                aria-label="Admin sections"
              >
                {visibleNav.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectSection(item.id)}
                    aria-current={section === item.id ? "page" : undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors",
                      section === item.id
                        ? "border-foreground bg-primary text-primary-foreground"
                        : "border-transparent text-muted-foreground hover:border-foreground hover:text-foreground",
                    )}
                  >
                    <item.icon className="size-3.5" aria-hidden />
                    {item.label}
                  </button>
                ))}
              </nav>
            </header>

            <main className="flex-1 px-4 py-5 sm:px-6">
              {!isModerator && !data.redisEnabled && (
                <div className="mb-4 flex flex-wrap items-start gap-3 rounded-md border border-border bg-warning/20 p-4 ">
                  <Database className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <p className="min-w-[12rem] flex-1 text-sm font-medium text-foreground">
                    Redis is not connected, so analytics are not being recorded. Connect Upstash for Redis to populate
                    this panel.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => selectSection("system")}>
                    <ServerCog className="size-4" aria-hidden />
                    View system status
                  </Button>
                </div>
              )}
              {/* `key={section}` re-mounts on every tab switch so the entrance
 animation (anim-rise) replays — content gently fades/slides in
 instead of snapping, which is what makes the panel feel like a
 reactive SPA rather than a static page reload. The checker is
 excluded because it must stay mounted to keep a bulk run alive. */}
              {!CHECKER_SECTIONS.includes(section) && (
                <div key={section} className="anim-rise">
                  {!isModerator && section === "overview" && <OverviewSection data={data} />}
                  {section === "saved" && <SavedSection role={role} />}
                  {section === "prime-saved" && (
                    <SavedSection
                      service="prime"
                      endpoint="/api/admin/saved-prime-cookies"
                      recheckStorageKey="admin-prime-saved-recheck"
                      role={role}
                    />
                  )}
                  {section === "crunchyroll-saved" && (
                    <SavedSection
                      service="crunchyroll"
                      endpoint="/api/admin/saved-crunchyroll-cookies"
                      recheckStorageKey="admin-crunchyroll-saved-recheck"
                      role={role}
                    />
                  )}
                  {!isModerator && section === "analytics" && <AnalyticsSection data={data} />}
                  {!isModerator && section === "activity" && <ActivitySection data={data} />}
                  {!isModerator && section === "system" && <SystemSection data={data} onChanged={refresh} />}
                  {!isModerator && section === "access-codes" && <AccessCodesSection />}
                </div>
              )}
              {/* Each checker stays MOUNTED across tab switches (hidden via CSS) so a
 running bulk check keeps going while you browse other tabs. It only
 pauses on a full page reload, via its own persistence layer. */}
              <div className={section === "checker" ? "" : "hidden"}>
                <CheckerSection
                  basePath="/admin/checker"
                  active={section === "checker"}
                  initialMode={initialSection === "checker" ? initialCheckerMode : "single"}
                />
              </div>
              <div className={section === "prime-checker" ? "" : "hidden"}>
                <CheckerSection
                  service="prime"
                  endpoint="/api/admin/saved-prime-cookies"
                  storageKey="admin-prime"
                  basePath="/admin/prime-checker"
                  active={section === "prime-checker"}
                  initialMode={initialSection === "prime-checker" ? initialCheckerMode : "single"}
                />
              </div>
              <div className={section === "crunchyroll-checker" ? "" : "hidden"}>
                <CheckerSection
                  service="crunchyroll"
                  endpoint="/api/admin/saved-crunchyroll-cookies"
                  storageKey="admin-crunchyroll"
                  basePath="/admin/crunchyroll-checker"
                  active={section === "crunchyroll-checker"}
                  initialMode={initialSection === "crunchyroll-checker" ? initialCheckerMode : "single"}
                />
              </div>
              <div className={section === "spotify-checker" ? "" : "hidden"}>
                <CheckerSection
                  service="spotify"
                  endpoint="/api/admin/saved-spotify-cookies"
                  storageKey="admin-spotify"
                  basePath="/admin/spotify-checker"
                  active={section === "spotify-checker"}
                  initialMode={initialSection === "spotify-checker" ? initialCheckerMode : "single"}
                />
              </div>
            </main>
          </div>
        </div>
      </BulkRunStatusProvider>
    </ConfirmProvider>
  )
}

// Compact, always-visible pill that mirrors the embedded bulk checker's run from
// any tab. Clicking it jumps to the Checker tab. Renders nothing when idle.
function BulkRunPill({ onJump }: { onJump: () => void }) {
  const { status, active } = useBulkRunStatus()
  if (!active) return null

  const label = status.preparing ? "Preparing proxies" : status.paused ? "Paused" : "Checking"

  return (
    <button
      type="button"
      onClick={onJump}
      title="Go to the running bulk check"
      className="group inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 transition-all duration-75 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {status.paused ? (
        <Pause className="size-3.5 shrink-0 text-warning" aria-hidden />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
      )}
      <span className="hidden font-mono text-[11px] font-semibold uppercase tracking-wider text-foreground sm:inline">
        {label}
      </span>
      <span className="font-mono text-[11px] font-bold tabular-nums text-foreground">
        {status.done}/{status.total}
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tabular-nums">
        <span className="text-success">{status.alive}A</span>
        <span className="text-muted-foreground">{status.dead}D</span>
        {status.error > 0 && <span className="text-destructive">{status.error}E</span>}
      </span>
      {/* Inline progress track */}
      <span
        className="relative hidden h-1.5 w-16 overflow-hidden border border-foreground bg-muted md:block"
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-300"
          style={{ width: `${status.progress}%` }}
        />
      </span>
    </button>
  )
}
