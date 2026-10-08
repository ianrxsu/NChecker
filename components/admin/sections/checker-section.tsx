"use client"

import { useCallback, useRef } from "react"
import { useSWRConfig } from "swr"
import { toast } from "sonner"
import { Database } from "lucide-react"
import { CheckerShell } from "@/components/checker/checker-shell"
import type { OnAlive } from "@/components/checker/single-checker"
import type { CheckResult } from "@/lib/cookie-utils"
import { useBulkRunStatus } from "@/components/admin/bulk-run-status"

export function CheckerSection({
  service = "netflix",
  endpoint = "/api/admin/saved-cookies",
  storageKey = "admin",
  basePath,
  active = true,
  initialMode = "single",
}: {
  // Which service this checker validates against. "prime" routes every check at
  // Amazon Prime and "crunchyroll" at Crunchyroll, each persisting hits into its
  // own dedicated pool.
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  // The admin saved-cookies API this checker POSTs alive hits to. Defaults to the
  // Netflix pool; the Prime/Crunchyroll tabs pass their own endpoint.
  endpoint?: string
  // Namespaces the bulk run's saved-progress snapshot so Netflix and Prime admin
  // runs don't clobber each other.
  storageKey?: string
  // Path this checker lives at (e.g. "/admin/checker") so the shell can write the
  // clean /admin/checker/bulk URL. `active` gates URL ownership (only the visible
  // checker syncs the address bar); `initialMode` is the server-resolved mode.
  basePath?: string
  active?: boolean
  initialMode?: "single" | "bulk"
} = {}) {
  // Shared SWR cache key with the matching Saved tab — revalidating it after a
  // save makes the Saved list update live without this component owning the table.
  const { mutate } = useSWRConfig()

  // Push bulk-run progress up to the admin shell so the header pill can show it
  // from any tab while this (always-mounted) checker keeps running.
  const { setStatus } = useBulkRunStatus()

  // Coalesce rapid alive callbacks (bulk fires per-chunk) into one POST.
  const queueRef = useRef<{ cookie: string; result: CheckResult }[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushQueue = useCallback(async () => {
    flushTimer.current = null
    const items = queueRef.current
    queueRef.current = []
    if (items.length === 0) return
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      const json = (await res.json().catch(() => null)) as { saved?: number; error?: string } | null
      if (!res.ok) throw new Error(json?.error || "Save failed.")
      // Saving is silent (no success toast) — the Saved tab refresh below is the
      // only feedback. Errors still surface via the catch block.
      // Refresh the shared key so the Saved tab reflects the new rows.
      await mutate(endpoint)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save alive accounts.")
    }
  }, [mutate, endpoint])

  const handleAlive: OnAlive = useCallback(
    (entries) => {
      queueRef.current.push(...entries)
      if (flushTimer.current == null) flushTimer.current = setTimeout(() => void flushQueue(), 400)
    },
    [flushQueue],
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-md border border-border bg-accent/15 px-4 py-3 ">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Database className="size-4 shrink-0 text-info" aria-hidden />
          {service === "prime"
            ? "Alive Amazon Prime accounts checked here are saved automatically to your private Prime database. View them in the Prime Saved tab."
            : service === "crunchyroll"
              ? "Alive Crunchyroll accounts checked here are saved automatically to your private Crunchyroll database. View them in the Crunchyroll Saved tab."
              : service === "steam"
                ? "Alive Steam accounts checked here are saved automatically to your private Steam database. View them in the Steam Saved tab."
                : service === "spotify"
                  ? "Alive Spotify Premium accounts checked here are saved automatically to your private Spotify database. View them in the Spotify Saved tab."
                  : "Alive accounts checked here are saved automatically to your private Neon database. View them in the Saved tab."}
        </p>
      </div>

      {/* The exact same checker as the public page, wired to persist alive hits.
 A distinct storageKey keeps the admin run's saved progress separate
 from the public one and survives reloads (restored as paused). */}
      <CheckerShell
        service={service}
        onAlive={handleAlive}
        storageKey={storageKey}
        isAdmin
        onRunStateChange={setStatus}
        basePath={basePath}
        active={active}
        initialMode={initialMode}
      />
    </div>
  )
}
