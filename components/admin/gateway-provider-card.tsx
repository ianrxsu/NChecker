"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Scissors, Loader2, ShieldCheck, TriangleAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DEFAULT_GATEWAY_PROVIDER, isGatewayProvider, type GatewayProvider } from "@/lib/gateway-provider"
import { StatusDot } from "./shared"

type ProviderState = {
  provider: GatewayProvider
  shrinkEarnConfigured: boolean
  oiiConfigured: boolean
  shortXLinksConfigured: boolean
}

const OPTIONS: {
  value: GatewayProvider
  label: string
  icon: React.ElementType
  blurb: string
  strength: "medium"
}[] = [
  {
    value: "shortxlinks",
    label: "ShortXLinks only",
    icon: Scissors,
    strength: "medium",
    blurb: "All unlocks use ShortXLinks and return to netflixchecker.i4n.tech. No other gateway is available.",
  },
]

export function GatewayProviderCard() {
  const [state, setState] = useState<ProviderState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<GatewayProvider | null>(null)

  useEffect(() => {
    let active = true
    fetch("/api/admin/gateway-provider")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ProviderState | null) => {
        if (!active) return
        setState(
          data && isGatewayProvider(data.provider)
            ? data
            : {
              provider: DEFAULT_GATEWAY_PROVIDER,
              shrinkEarnConfigured: false,
              oiiConfigured: false,
              shortXLinksConfigured: false,
            },
        )
      })
      .catch(
        () =>
          active &&
          setState({
            provider: DEFAULT_GATEWAY_PROVIDER,
            shrinkEarnConfigured: false,
            oiiConfigured: false,
            shortXLinksConfigured: false,
          }),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  async function choose(provider: GatewayProvider) {
    if (!state || provider === state.provider || saving) return
    setSaving(provider)
    try {
      const res = await fetch("/api/admin/gateway-provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      const saved: ProviderState = await res.json()
      setState(saved)
      const label = OPTIONS.find((o) => o.value === saved.provider)?.label ?? saved.provider
      toast.success(`Gateway switched to ${label}`, {
        description: "New generator sessions use it immediately.",
      })
    } catch (err) {
      toast.error("Could not switch gateway", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setSaving(null)
    }
  }

  const active = state?.provider ?? DEFAULT_GATEWAY_PROVIDER
  const usingShrinkOnly = active === "shrinkearn_only"
  const needsShrink = ["shrinkearn", "shrinkearn_only", "shrinkearn_then_lootlabs", "shrinkearn_then_oii"].includes(active)
  const needsOii = ["oii", "oii_only", "shrinkearn_then_oii"].includes(active)
  const shrinkMisconfigured = needsShrink && state?.shrinkEarnConfigured === false
  const oiiMisconfigured = needsOii && state?.oiiConfigured === false
  const shortXLinksMisconfigured = active === "shortxlinks" && state?.shortXLinksConfigured === false

  return (
    <Card className={usingShrinkOnly ? "border-warning/60" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot state={usingShrinkOnly ? "degraded" : "ok"} pulse={usingShrinkOnly} />
          Unlock gateway
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Which gateway users pass through before an account is distributed. Switch anytime — no redeploy.
        </p>

        {loading || !state ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading current gateway…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {OPTIONS.map((opt) => {
                const selected = active === opt.value
                const Icon = opt.icon
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => choose(opt.value)}
                    disabled={saving !== null}
                    aria-pressed={selected}
                    className={`flex w-full flex-col gap-2 rounded-md border border-border p-4 text-left transition-all duration-75 disabled:opacity-60 ${
                      selected ? "bg-foreground text-background" : "bg-card text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <Icon className="size-4" aria-hidden />
                        {opt.label}
                      </span>
                      {selected ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-widest">
                          {saving === opt.value ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <ShieldCheck className="size-3.5" aria-hidden />
                          )}
                          Active
                        </span>
                      ) : saving === opt.value ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : null}
                    </div>
                    <p
                      className={`text-xs leading-relaxed ${selected ? "text-background/80" : "text-muted-foreground"}`}
                    >
                      {opt.blurb}
                    </p>
                  </button>
                )
              })}
            </div>

            {shrinkMisconfigured && (
              <div className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-semibold">SHRINKEARN_API_TOKEN is not set.</span> ShrinkEarn can&apos;t build
                  short links — every start safely falls back to the configured fallback. Add the token in Vars to
                  activate ShrinkEarn.
                </span>
              </div>
            )}

            {oiiMisconfigured && (
              <div className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-semibold">OII_API_TOKEN is not set.</span> oii.io can&apos;t build short
                  links — sessions fall back to LootLabs. Add the token in Vars to activate oii.io.
                </span>
              </div>
            )}

            {shortXLinksMisconfigured && (
              <div className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-semibold">SHORTXLINKS_API_TOKEN is not set.</span> ShortXLinks can&apos;t
                  build short links — sessions fall back to LootLabs. Add the token in Vars to activate ShortXLinks.
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
