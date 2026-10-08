"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Eye, EyeOff, Gift, Layers, Link2, Loader2, Save, Sparkles } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  defaultVisibility,
  PUBLIC_CHECKER_SERVICES,
  type CheckerService,
  type CheckerVisibility,
} from "@/lib/checker-visibility"
import { StatusDot } from "./shared"

const SERVICE_LABELS: Record<CheckerService, string> = {
  netflix: "Netflix",
  prime: "Prime",
  crunchyroll: "Crunchyroll",
}

// Small brutalist on/off toggle matching the app's hard-border style. "On" here
// means the restriction is ACTIVE (i.e. something is hidden), so it uses the
// destructive/warning color to read as "this is turned off for the public".
function Toggle({
  on,
  onChange,
  disabled,
  labelOn,
  labelOff,
  icon: Icon,
  positive = false,
}: {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  labelOn: string
  labelOff: string
  icon: React.ElementType
  // When true, the "on" state reads as a GOOD/enabled state (primary color)
  // rather than the default restriction/hidden state (destructive color).
  positive?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-widest shadow-lg transition-all duration-75 disabled:opacity-50 ${
        on
          ? positive
            ? "bg-primary text-primary-foreground"
            : "bg-destructive text-destructive-foreground"
          : "bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      {on ? labelOn : labelOff}
    </button>
  )
}

// Admin control for hiding the PUBLIC checkers. Self-contained: reads/writes
// /api/admin/checker-visibility directly. The admin panel's own checkers are never
// affected — this only gates what public visitors see.
export function CheckerVisibilityCard() {
  const [vis, setVis] = useState<CheckerVisibility | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    fetch("/api/admin/checker-visibility")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: CheckerVisibility | null) => {
        if (!active) return
        setVis(data ?? defaultVisibility())
      })
      .catch(() => active && setVis(defaultVisibility()))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  function update(next: CheckerVisibility) {
    setVis(next)
    setDirty(true)
  }

  function setAllHidden(allHidden: boolean) {
    if (!vis) return
    update({ ...vis, allHidden })
  }

  function setSmartCheckerEnabled(smartCheckerEnabled: boolean) {
    if (!vis) return
    update({ ...vis, smartCheckerEnabled })
  }

  function setLinksOnly(linksOnly: boolean) {
    if (!vis) return
    update({ ...vis, linksOnly })
  }

  function setNetflixGeneratorLinksOnly(netflixGeneratorLinksOnly: boolean) {
    if (!vis) return
    update({ ...vis, netflixGeneratorLinksOnly })
  }

  function setExtensionHidden(extensionHidden: boolean) {
    if (!vis) return
    update({ ...vis, extensionHidden })
  }

  function setAutoProxyScrapeEnabled(autoProxyScrapeEnabled: boolean) {
    if (!vis) return
    update({ ...vis, autoProxyScrapeEnabled })
  }

  function setService(service: CheckerService, patch: Partial<CheckerVisibility["services"][CheckerService]>) {
    if (!vis) return
    update({
      ...vis,
      services: { ...vis.services, [service]: { ...vis.services[service], ...patch } },
    })
  }

  function setGenerator(service: CheckerService, hidden: boolean) {
    if (!vis) return
    update({ ...vis, generators: { ...vis.generators, [service]: hidden } })
  }

  async function save() {
    if (!vis) return
    setSaving(true)
    try {
      const res = await fetch("/api/admin/checker-visibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vis),
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const saved: CheckerVisibility = await res.json()
      setVis(saved)
      setDirty(false)
      toast.success("Checker visibility updated", {
        description: "Public pages reflect the change immediately.",
      })
    } catch (err) {
      toast.error("Could not update visibility", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  const anyHidden =
    vis?.allHidden ||
    vis?.extensionHidden ||
    PUBLIC_CHECKER_SERVICES.some(
      (s) => vis?.services[s].hidden || vis?.services[s].bulkHidden || vis?.generators[s],
    )

  return (
    <Card className={anyHidden ? "border-warning/60" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot state={anyHidden ? "degraded" : "ok"} pulse={anyHidden} />
          Public checker visibility
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Control what public visitors can see. Hide every checker at once, hide a single service, or hide just its bulk
          checker. Your admin checkers are never affected.
        </p>

        {loading || !vis ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading current settings…
          </div>
        ) : (
          <>
            {/* Master switch */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Hide all public checkers</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Master switch. When on, none of the checkers are reachable by the public — every checker route shows
                  an “unavailable” notice.
                </p>
              </div>
              <Toggle
                on={vis.allHidden}
                onChange={setAllHidden}
                labelOn="Hidden"
                labelOff="Visible"
                icon={vis.allHidden ? EyeOff : Eye}
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-muted p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Auto Proxy Scrape for public checkers</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When off, public visitors must provide their own proxies. Admin checkers can still scrape automatically.
                </p>
              </div>
              <Toggle
                on={vis.autoProxyScrapeEnabled}
                onChange={setAutoProxyScrapeEnabled}
                labelOn="Auto on"
                labelOff="Manual only"
                icon={vis.autoProxyScrapeEnabled ? Layers : Link2}
                positive
              />
            </div>

            {/* Unified smart checker — opt-in all-in-one page at /checker */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-muted p-4">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Sparkles className="size-4 text-primary" aria-hidden />
                  Smart all-in-one checker
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Exposes a unified checker at <span className="font-mono">/checker</span> that auto-detects
                  Netflix, Prime, or Crunchyroll cookies (or lets visitors pick a service). Respects the per-service
                  hides below. Turned off by the master switch too.
                </p>
              </div>
              <Toggle
                on={vis.smartCheckerEnabled}
                onChange={setSmartCheckerEnabled}
                disabled={vis.allHidden}
                positive
                labelOn="Enabled"
                labelOff="Disabled"
                icon={Sparkles}
              />
            </div>

            {/* Links-only mode — public checkers */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Direct links only (no cookies)</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When on, public checker results show <span className="font-semibold text-foreground">Direct Auth Links only</span> — all cookie copy actions (Copy cookies, raw, Netscape, manual reveal) are hidden. Admin checkers are never affected.
                </p>
              </div>
              <Toggle
                on={vis.linksOnly}
                onChange={setLinksOnly}
                disabled={vis.allHidden}
                labelOn="Links only"
                labelOff="Full results"
                icon={Link2}
              />
            </div>

            {/* Links-only mode — Netflix account generator */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Netflix generator — direct links only</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When on, checker and rechecker results inside the{" "}
                  <span className="font-semibold text-foreground">Netflix account generator</span> show Direct Auth
                  Links only — all cookie copy actions are hidden. Prime and Crunchyroll generators are never affected.
                </p>
              </div>
              <Toggle
                on={vis.netflixGeneratorLinksOnly}
                onChange={setNetflixGeneratorLinksOnly}
                labelOn="Links only"
                labelOff="Full results"
                icon={Link2}
              />
            </div>

            {/* Public browser extension */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Public browser extension</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Show or hide the public extension page and its download button. Private extension API routes are not affected.
                </p>
              </div>
              <Toggle
                on={!vis.extensionHidden}
                onChange={(next) => setExtensionHidden(!next)}
                labelOn="Shown"
                labelOff="Hidden"
                icon={vis.extensionHidden ? EyeOff : Eye}
                positive
              />
            </div>

            {/* Per-service controls */}
            <div className="space-y-2">
              {PUBLIC_CHECKER_SERVICES.map((svc) => {
                const s = vis.services[svc]
                const dimmed = vis.allHidden || s.hidden
                return (
                  <div
                    key={svc}
                    className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{SERVICE_LABELS[svc]}</span>
                      {vis.allHidden && (
                        <span className="rounded-md border border-foreground bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                          Hidden by master
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Toggle
                        on={s.hidden}
                        onChange={(next) => setService(svc, { hidden: next })}
                        disabled={vis.allHidden}
                        labelOn="Checker hidden"
                        labelOff="Checker visible"
                        icon={s.hidden ? EyeOff : Eye}
                      />
                      <Toggle
                        on={s.bulkHidden}
                        onChange={(next) => setService(svc, { bulkHidden: next })}
                        disabled={dimmed}
                        labelOn="Bulk hidden"
                        labelOff="Bulk visible"
                        icon={Layers}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Per-generator hides — the three PUBLIC account generators. Fully
                independent of the checker hides above. */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1 pt-1">
                <Gift className="size-3.5 text-primary" aria-hidden />
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Public account generators
                </p>
              </div>
              <p className="px-1 text-xs text-muted-foreground">
                Hide any of the three free account generators from the public. A hidden generator shows an
                “unavailable” notice and is dropped from the home page and footer links. Checkers are never affected.
              </p>
              {PUBLIC_CHECKER_SERVICES.map((svc) => {
                const hidden = vis.generators[svc]
                return (
                  <div
                    key={svc}
                    className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm font-semibold text-foreground">{SERVICE_LABELS[svc]} generator</span>
                    <Toggle
                      on={hidden}
                      onChange={(next) => setGenerator(svc, next)}
                      labelOn="Generator hidden"
                      labelOff="Generator visible"
                      icon={hidden ? EyeOff : Eye}
                    />
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-end">
              <Button type="button" size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-4" aria-hidden />
                )}
                {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
