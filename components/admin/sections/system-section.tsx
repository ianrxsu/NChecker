"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Database, Globe, KeyRound, ShieldCheck, Server, Trash2, Gauge, Zap } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { AdminData } from "@/lib/use-admin-metrics"
import { StatusDot, stateColor, formatRelative, formatNumber } from "../shared"
import { KillSwitchCard } from "../kill-switch-card"
import { BrandColorCard } from "../brand-color-card"
import { CheckerVisibilityCard } from "../checker-visibility-card"
import { GatewayProviderCard } from "../gateway-provider-card"
import { AccessPassCard } from "../access-pass-card"
import { ClaimLimitsCard } from "../claim-limits-card"
import { ResetMyLimitsCard } from "../reset-my-limits-card"
import { BackupCard } from "../backup-card"
import { ModeratorAccessCard } from "../moderator-access-card"
import { PublicAccessCard } from "../public-access-card"
import { TelegramSettingsCard } from "../telegram-settings-card"

function StatusRow({
  icon: Icon,
  title,
  detail,
  state,
  value,
}: {
  icon: React.ElementType
  title: string
  detail: string
  state: "ok" | "degraded" | "off"
  value?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-md glass p-4">
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot state={state} pulse />
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        <p className={`mt-0.5 truncate text-xs ${stateColor(state)}`}>{detail}</p>
      </div>
      {value && <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{value}</span>}
    </div>
  )
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

// Live free-tier usage sampled in-process (per warm instance). Neon's real cap is
// COMPUTE TIME (it autosuspends when idle), so query count is shown as a load
// signal, not a budget bar. Upstash bills per COMMAND, so its projected monthly
// rate is shown against a reference budget.
function UsageCard({ usage }: { usage: AdminData["system"]["usage"] }) {
  const redisPctState: "ok" | "degraded" | "off" = usage.redis.monthlyBudgetUsedPct >= 80 ? "degraded" : "ok"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Free-tier usage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md glass p-4">
            <div className="flex items-center gap-2">
              <Database className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-semibold text-foreground">Neon (Postgres)</span>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Queries (this instance)</dt>
                <dd className="font-mono tabular-nums text-foreground">{formatNumber(usage.neon.queries)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Rate</dt>
                <dd className="font-mono tabular-nums text-foreground">{usage.neon.perMinute}/min</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Projected</dt>
                <dd className="font-mono tabular-nums text-foreground">
                  ~{formatNumber(usage.neon.perDayEstimate)}/day
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Neon&apos;s free cap is compute time, not query count — it autosuspends when idle, so a low steady rate
              keeps you well under budget.
            </p>
          </div>

          <div className="rounded-md glass p-4">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-semibold text-foreground">Upstash (Redis)</span>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Commands (this instance)</dt>
                <dd className="font-mono tabular-nums text-foreground">{formatNumber(usage.redis.commands)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Rate</dt>
                <dd className="font-mono tabular-nums text-foreground">{usage.redis.perMinute}/min</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Projected</dt>
                <dd className="font-mono tabular-nums text-foreground">
                  ~{formatNumber(usage.redis.perDayEstimate)}/day
                </dd>
              </div>
            </dl>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Est. monthly budget</span>
                <span className={`font-mono tabular-nums ${stateColor(redisPctState)}`}>
                  {usage.redis.monthlyBudgetUsedPct}%
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-md bg-muted"
                role="progressbar"
                aria-valuenow={usage.redis.monthlyBudgetUsedPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Projected monthly Redis command budget used"
              >
                <div
                  className={redisPctState === "degraded" ? "h-full bg-warning" : "h-full bg-success"}
                  style={{ width: `${usage.redis.monthlyBudgetUsedPct}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Projected from this instance&apos;s rate vs. a {formatNumber(usage.redis.monthlyBudget)}/mo reference.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Gauge className="size-3.5" aria-hidden />
          <span>
            Sampled in-process over {formatUptime(usage.uptimeMs)} of uptime on this warm instance — a live load signal,
            not a global billing total (counters reset on cold start and aren&apos;t summed across instances).
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

export function SystemSection({ data, onChanged }: { data: AdminData; onChanged: () => void }) {
  const { system, metrics } = data
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function handleReset() {
    setResetting(true)
    try {
      const res = await fetch("/api/admin/metrics/reset", { method: "POST" })
      if (!res.ok) throw new Error(`Reset failed (${res.status})`)
      toast.success("Analytics cleared", { description: "All stored metrics were reset." })
      setConfirming(false)
      onChanged()
    } catch (err) {
      toast.error("Could not reset analytics", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="space-y-4">
      <ModeratorAccessCard />

      <PublicAccessCard />

      <KillSwitchCard />

      <BrandColorCard />

      <CheckerVisibilityCard />

      <GatewayProviderCard />

      <TelegramSettingsCard />

      <AccessPassCard />

      <ClaimLimitsCard enabled={data.redisEnabled} />

      <ResetMyLimitsCard />

      <BackupCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Service health</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <StatusRow
            icon={Database}
            title="Redis (analytics DB)"
            detail={system.redis.label}
            state={system.redis.state}
            value={system.redis.pingMs !== null ? `${system.redis.pingMs}ms` : undefined}
          />
          <StatusRow
            icon={Globe}
            title="Upstream checker"
            detail={system.upstream.label}
            state={system.upstream.state}
            value={system.upstream.mode.toUpperCase()}
          />
          <StatusRow icon={KeyRound} title="Session secret" detail={system.auth.label} state={system.auth.state} />
          <StatusRow
            icon={ShieldCheck}
            title="Rate limiting"
            detail={`${system.rateLimit.cookiesPerMinute}/min checks · ${system.rateLimit.loginAttemptsPerMinute}/min logins`}
            state="ok"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Runtime</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Environment</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Server className="size-3.5 text-muted-foreground" aria-hidden />
                {system.runtime.env}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Region</dt>
              <dd className="mt-1 text-sm text-foreground">{system.runtime.region}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Node</dt>
              <dd className="mt-1 text-sm text-foreground">{system.runtime.nodeVersion}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-muted-foreground">First check</dt>
              <dd className="mt-1 text-sm text-foreground">{formatRelative(metrics.firstSeen)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <UsageCard usage={system.usage} />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Reset all analytics</p>
              <p className="text-xs text-muted-foreground">
                Permanently clears every counter, trend bucket, and activity event from Redis. This cannot be undone.
              </p>
            </div>
            {confirming ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={resetting}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={handleReset} disabled={resetting}>
                  <Trash2 className="size-4" aria-hidden />
                  {resetting ? "Clearing…" : "Confirm reset"}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => setConfirming(true)}
                disabled={!data.redisEnabled}
              >
                <Trash2 className="size-4" aria-hidden />
                Reset analytics
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Separator />
      <p className="text-center text-xs text-muted-foreground">
        Analytics are stored in Upstash Redis and update in real time.
      </p>
    </div>
  )
}
