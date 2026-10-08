"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Ticket, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusDot } from "./shared"

// Toggles Access Pass mode: when ON, a user passes the gateway link ONCE and gets a
// 24h pass (per device) that unlocks every generator without the gateway. Per-service
// claim limits still apply. When OFF, every account requires passing the gateway.
export function AccessPassCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    fetch("/api/admin/access-pass")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!active) return
        setEnabled(Boolean(data?.enabled))
      })
      .catch(() => active && setEnabled(false))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  async function choose(next: boolean) {
    if (saving || next === enabled) return
    setSaving(true)
    try {
      const res = await fetch("/api/admin/access-pass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      const saved: { enabled: boolean } = await res.json()
      setEnabled(saved.enabled)
      toast.success(saved.enabled ? "Access Pass mode enabled" : "Access Pass mode disabled", {
        description: saved.enabled
          ? "Users pass one link to unlock all generators for 24h."
          : "Every account now requires passing the gateway link.",
      })
    } catch (err) {
      toast.error("Could not change Access Pass mode", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot state={enabled ? "ok" : "off"} pulse={Boolean(enabled)} />
          Access Pass mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          When on, a user passes the unlock link <span className="font-semibold text-foreground">once</span> and earns a{" "}
          <span className="font-semibold text-foreground">24-hour pass</span> (per device) that unlocks the Netflix,
          Prime and Crunchyroll generators without the gateway. Per-service claim limits still apply. When off, every
          account requires passing the gateway.
        </p>

        {loading || enabled === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading current mode…
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: false, label: "Per-claim gating", blurb: "Every account needs the link. Default." },
              { value: true, label: "24h Access Pass", blurb: "One link unlocks all for 24h." },
            ].map((opt) => {
              const selected = enabled === opt.value
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => choose(opt.value)}
                  disabled={saving}
                  aria-pressed={selected}
                  className={`flex flex-col gap-1.5 rounded-md border border-border p-4 text-left transition-all duration-75 disabled:opacity-60 ${
                    selected ? "bg-foreground text-background" : "bg-card text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {opt.value ? <Ticket className="size-4" aria-hidden /> : null}
                    {opt.label}
                    {saving && selected ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  </span>
                  <span className={`text-xs leading-relaxed ${selected ? "text-background/80" : "text-muted-foreground"}`}>
                    {opt.blurb}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
