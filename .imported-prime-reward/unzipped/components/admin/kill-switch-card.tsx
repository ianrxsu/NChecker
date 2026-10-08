"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Power, PowerOff } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { StatusDot, formatRelative } from "./shared"

type KillState = { enabled: boolean; message: string | null; since: number | null }

// Self-contained kill switch. Reads/writes /api/admin/kill-switch directly so it
// stays in sync regardless of the metrics polling cycle. When ON, the root
// middleware sends every public page to the maintenance screen.
export function KillSwitchCard() {
  const confirm = useConfirm()
  const [state, setState] = useState<KillState | null>(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  // Avoid clobbering what the admin is typing once we've loaded the saved note.
  const seededMessage = useRef(false)

  // Load the current state on mount.
  useEffect(() => {
    let active = true
    fetch("/api/admin/kill-switch")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: KillState | null) => {
        if (!active || !data) return
        setState(data)
        if (!seededMessage.current && data.message) {
          setMessage(data.message)
          seededMessage.current = true
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  async function toggle(enabled: boolean) {
    if (enabled) {
      const ok = await confirm({
        title: "Enable maintenance mode?",
        description:
          "This immediately takes ALL public pages offline and shows the maintenance screen to every visitor. Checkers and account generators stop responding until you turn it back off. The admin panel and LootLabs postbacks keep working.",
        confirmLabel: "Take site offline",
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/admin/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, message: message.trim() || null }),
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const next: KillState = await res.json()
      setState(next)
      toast.success(enabled ? "Site is now in maintenance mode" : "Site is back online", {
        description: enabled
          ? "All public pages now show the maintenance screen."
          : "Public pages are serving normally again.",
      })
    } catch (err) {
      toast.error("Could not update maintenance mode", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setBusy(false)
    }
  }

  const enabled = state?.enabled ?? false

  return (
    <Card className={enabled ? "border-destructive/60" : "border-warning/50"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot state={enabled ? "off" : "ok"} pulse={enabled} />
          Kill switch — maintenance mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 rounded-md glass p-4">
          {enabled ? (
            <PowerOff className="size-5 text-destructive" aria-hidden />
          ) : (
            <Power className="size-5 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {enabled ? "Public site is OFFLINE" : "Public site is live"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enabled
                ? `Maintenance screen shown to all visitors since ${formatRelative(state?.since ?? null)}.`
                : "All checkers and account generators are serving normally."}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="maintenance-note"
            className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
          >
            Message shown to visitors (optional)
          </label>
          <textarea
            id="maintenance-note"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            maxLength={280}
            placeholder="We'll be back shortly — performing scheduled maintenance."
            className="w-full resize-none rounded-md border border-border bg-background p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          {enabled && (
            <Button variant="outline" size="sm" onClick={() => toggle(true)} disabled={busy}>
              Update message
            </Button>
          )}
          {enabled ? (
            <Button variant="default" size="sm" onClick={() => toggle(false)} disabled={busy}>
              <Power className="size-4" aria-hidden />
              {busy ? "Working…" : "Bring site back online"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => toggle(true)}
              disabled={busy}
            >
              <PowerOff className="size-4" aria-hidden />
              {busy ? "Working…" : "Take site offline"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
