"use client"

import { useState, useCallback, useEffect } from "react"
import { User, Layers } from "lucide-react"
import { SingleChecker, type OnAlive } from "@/components/checker/single-checker"
import { BulkChecker } from "@/components/checker/bulk-checker"
import { TelegramPromo } from "@/components/telegram-promo"

type Mode = "single" | "bulk"

// Builds the clean, path-based URL for a mode: single → the base path itself,
// bulk → "<base>/bulk". This replaces the old ?mode=bulk query param so links read
// like /netflix/bulk or /admin/checker/bulk.
function modeUrl(basePath: string, mode: Mode): string {
  return mode === "bulk" ? `${basePath}/bulk` : basePath
}

// `onAlive` is optional: the public page omits it, while the admin checker
// passes a handler that persists alive accounts to the database.
// `storageKey` namespaces the bulk checker's saved-progress snapshot so the
// public and admin checkers persist independently (admin defaults to "admin").
// `isAdmin` lets admin bulk runs under the live-scrape threshold check directly
// from the server (no proxy), while public always routes through live proxies.
// `initialMode` is resolved on the SERVER from the ?mode= query param and passed
// in, so the correct tab is server-rendered on first paint — this eliminates the
// "flash of single then snap to bulk" that happened when the choice was restored
// in a client effect after hydration.
export function CheckerShell({
  onAlive,
  storageKey = "public",
  isAdmin = false,
  autoProxyScrapeEnabled = true,
  initialMode = "single",
  onRunStateChange,
  service = "netflix",
  basePath = "",
  active = true,
  allowBulk = true,
  linksOnly = false,
}: {
  onAlive?: OnAlive
  storageKey?: string
  isAdmin?: boolean
  autoProxyScrapeEnabled?: boolean
  initialMode?: Mode
  // When false, the bulk checker is hidden entirely (tab + panel) and the shell is
  // locked to single mode. Used by the PUBLIC pages when an admin has hidden bulk
  // for that service. Admin checkers always leave this true.
  allowBulk?: boolean
  // When true (admin "direct links only" mode), cookie copy actions are suppressed
  // in result reports. Always false for admin checkers.
  linksOnly?: boolean
  // Which streaming service the checker targets (Netflix, Amazon Prime, or Crunchyroll).
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  // Optional passthrough so the admin shell can mirror bulk-run progress into a
  // global header pill. Ignored on the public page.
  onRunStateChange?: React.ComponentProps<typeof BulkChecker>["onRunStateChange"]
  // Path this checker lives at (e.g. "/netflix" or "/admin/checker"). The mode is
  // appended as a clean segment ("/bulk") rather than a ?mode= query param.
  basePath?: string
  // Whether this shell is the currently-visible view. In the admin panel all three
  // checkers stay mounted (only one shown), so only the active one is allowed to
  // own/sync the URL — otherwise the hidden ones would clobber it. Public pages
  // render a single shell and leave this at the default `true`.
  active?: boolean
}) {
  // When bulk is hidden, the shell is always in single mode regardless of the URL.
  const [mode, setMode] = useState<Mode>(allowBulk ? initialMode : "single")

  // Public Netflix checks persist alive results immediately in Neon. The endpoint
  // encrypts the cookie before storage and upserts by account fingerprint.
  const persistAlive = useCallback<OnAlive>((entries) => {
    void fetch("/api/checker/save-alive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }).catch(() => undefined)
  }, [])
  const aliveHandler = onAlive ?? persistAlive

  // Selecting a tab writes the clean path URL via replaceState (no new history
  // entry, no remount — keeps a running bulk check alive) so the choice survives a
  // reload and is shareable. Only the active shell touches the URL.
  const selectMode = useCallback(
    (next: Mode) => {
      setMode(next)
      if (active && basePath) window.history.replaceState(null, "", modeUrl(basePath, next))
    },
    [active, basePath],
  )

  // When this shell becomes the active view (e.g. switching back to it in the admin
  // panel, where it kept its own mode while hidden), re-sync the URL to match its
  // current mode so the address bar and a reload always reflect what's on screen.
  useEffect(() => {
    if (active && basePath) {
      const target = modeUrl(basePath, mode)
      if (window.location.pathname !== target) window.history.replaceState(null, "", target)
    }
  }, [active, basePath, mode])

  return (
    <div className="flex flex-col gap-5">
      <TelegramPromo />
      {/* Tabs — only shown when bulk is available. With bulk hidden there's just the
 single checker, so a one-tab switcher would be pointless. */}
      {allowBulk && (
        <div
          role="tablist"
          aria-label="Checker mode"
          className="inline-flex w-full max-w-xs items-center gap-1 rounded-lg glass p-1.5"
        >
          <TabButton active={mode === "single"} onClick={() => selectMode("single")} icon={User} label="single" />
          <TabButton active={mode === "bulk"} onClick={() => selectMode("bulk")} icon={Layers} label="bulk" />
        </div>
      )}

      {/* Keep both mounted to preserve input when switching.
 animate-in replays each time a panel returns from display:none. */}
      <div
        className={mode === "single" ? "animate-in fade-in-0 slide-in-from-bottom-1 duration-300" : "hidden"}
        role="tabpanel"
        aria-label="Single checker"
      >
        <SingleChecker onAlive={aliveHandler} service={service} linksOnly={linksOnly} />
      </div>
      {/* Bulk checker is not even mounted when hidden — no public bulk access. */}
      {allowBulk && (
        <div
          className={mode === "bulk" ? "animate-in fade-in-0 slide-in-from-bottom-1 duration-300" : "hidden"}
          role="tabpanel"
          aria-label="Bulk checker"
        >
          <BulkChecker
            onAlive={aliveHandler}
            storageKey={storageKey}
            isAdmin={isAdmin}
            autoProxyScrapeEnabled={autoProxyScrapeEnabled}
            onRunStateChange={onRunStateChange}
            service={service}
            linksOnly={linksOnly}
          />
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof User
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`press inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm tracking-widest transition-all duration-150 ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  )
}
