"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { SlidersHorizontal, Save } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  type ClaimLimits,
  type ClaimWindowUnit,
  DEFAULT_CLAIM_LIMITS,
  WINDOW_SECONDS,
  formatClaimLabel,
  unitFromSeconds,
} from "@/lib/claim-limits"

type Service = "netflix" | "prime" | "crunchyroll"

const SERVICE_META: { id: Service; label: string }[] = [
  { id: "netflix", label: "Netflix" },
  { id: "prime", label: "Amazon Prime" },
  { id: "crunchyroll", label: "Crunchyroll" },
]

// Editable row state — keep the count as a string so the input can be cleared while
// typing without snapping to a number; it's validated/clamped on save.
type RowDraft = { count: string; unit: ClaimWindowUnit }
type Draft = Record<Service, RowDraft>

function limitsToDraft(limits: ClaimLimits): Draft {
  return {
    netflix: { count: String(limits.netflix.limit), unit: unitFromSeconds(limits.netflix.windowSeconds) },
    prime: { count: String(limits.prime.limit), unit: unitFromSeconds(limits.prime.windowSeconds) },
    crunchyroll: { count: String(limits.crunchyroll.limit), unit: unitFromSeconds(limits.crunchyroll.windowSeconds) },
  }
}

// Admin-configurable account-generation rate limits. Reads/writes
// /api/admin/claim-limits directly (independent of the metrics polling cycle), and
// the saved values take effect instantly on the public generators via Redis.
export function ClaimLimitsCard({ enabled = true }: { enabled?: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => limitsToDraft(DEFAULT_CLAIM_LIMITS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load the current saved limits on mount.
  useEffect(() => {
    let active = true
    fetch("/api/admin/claim-limits")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { limits: ClaimLimits } | null) => {
        if (!active || !data?.limits) return
        setDraft(limitsToDraft(data.limits))
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  function updateRow(service: Service, patch: Partial<RowDraft>) {
    setDraft((d) => ({ ...d, [service]: { ...d[service], ...patch } }))
  }

  async function handleSave() {
    // Build the payload, clamping each count to 1–100 (server clamps too).
    const limits = {} as ClaimLimits
    for (const { id } of SERVICE_META) {
      const n = Math.floor(Number(draft[id].count))
      const limit = Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : DEFAULT_CLAIM_LIMITS[id].limit
      limits[id] = { limit, windowSeconds: WINDOW_SECONDS[draft[id].unit] }
    }
    setSaving(true)
    try {
      const res = await fetch("/api/admin/claim-limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limits }),
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data: { limits: ClaimLimits } = await res.json()
      setDraft(limitsToDraft(data.limits))
      toast.success("Claim limits updated", {
        description: "New caps apply immediately to the account generators.",
      })
    } catch (err) {
      toast.error("Could not save claim limits", {
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
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
          Account generation limits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Cap how many free accounts a single visitor can unlock per window, per service. Counts are enforced on both IP
          and device, and apply instantly with no redeploy.
        </p>

        <div className="space-y-3">
          {SERVICE_META.map(({ id, label }) => {
            const row = draft[id]
            const count = Math.min(100, Math.max(1, Math.floor(Number(row.count)) || 1))
            return (
              <div key={id} className="flex flex-wrap items-center gap-3 rounded-md glass p-4">
                <span className="min-w-28 flex-1 text-sm font-semibold text-foreground">{label}</span>

                <div className="flex items-center gap-2">
                  <label htmlFor={`limit-${id}`} className="sr-only">
                    {`${label} accounts per window`}
                  </label>
                  <input
                    id={`limit-${id}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    value={row.count}
                    disabled={!enabled || loading}
                    onChange={(e) => updateRow(id, { count: e.target.value })}
                    className="w-20 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none focus: disabled:opacity-50"
                  />
                  <span className="text-xs text-muted-foreground">per</span>
                  <label htmlFor={`unit-${id}`} className="sr-only">
                    {`${label} window unit`}
                  </label>
                  <select
                    id={`unit-${id}`}
                    value={row.unit}
                    disabled={!enabled || loading}
                    onChange={(e) => updateRow(id, { unit: e.target.value as ClaimWindowUnit })}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus: disabled:opacity-50"
                  >
                    <option value="hour">hour</option>
                    <option value="day">day</option>
                  </select>
                </div>

                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {formatClaimLabel(count, WINDOW_SECONDS[row.unit])}
                </span>
              </div>
            )
          })}
        </div>

        {!enabled && (
          <p className="text-xs text-warning">
            Redis is not configured, so limits cannot be saved and the generators run unthrottled.
          </p>
        )}

        <div className="flex items-center justify-end">
          <Button size="sm" onClick={handleSave} disabled={!enabled || loading || saving}>
            <Save className="size-4" aria-hidden />
            {saving ? "Saving…" : "Save limits"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
