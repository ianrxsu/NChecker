"use client"

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  Activity,
  CircleCheck,
  CircleX,
  TriangleAlert,
  ShieldAlert,
  Gauge,
  Layers,
  Clock,
  Gift,
  Users,
  Route,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import type { AdminData } from "@/lib/use-admin-metrics"
import { useMounted } from "@/lib/use-mounted"
import { formatDuration, formatNumber, formatRelative, pct } from "../shared"

const trendConfig = {
  total: { label: "Checks", color: "var(--chart-1)" },
} satisfies ChartConfig

function Kpi({
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
  tone?: "default" | "success" | "danger" | "warning" | "info"
}) {
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : tone === "warning"
          ? "text-warning"
          : tone === "info"
            ? "text-info"
            : "text-foreground"
  return (
    <Card className="transition-all duration-75 ">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
          <Icon className={`size-4 ${toneCls}`} aria-hidden />
        </div>
        <p className={`mt-3 text-3xl font-semibold tabular-nums ${toneCls}`}>{value}</p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
}

export function OverviewSection({ data }: { data: AdminData }) {
  const m = data.metrics
  const mounted = useMounted()
  const trend = m.perDay.map((d) => ({ day: d.day.slice(5), total: d.total }))

  // Compact per-service breakdown for the generations KPI sub-label.
  const SERVICE_LABELS: Record<string, string> = { netflix: "Netflix", prime: "Prime", crunchyroll: "Crunchyroll" }
  const genBreakdown = Object.entries(m.generationsByService)
    .filter(([, n]) => n > 0)
    .map(([svc, n]) => `${SERVICE_LABELS[svc] ?? svc} ${formatNumber(n)}`)
    .join(" · ")

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={Activity} label="Total checks" value={formatNumber(m.total)} sub={`${formatNumber(m.runs)} runs`} />
        <Kpi
          icon={CircleCheck}
          label="Alive"
          value={formatNumber(m.alive)}
          sub={`${pct(m.alive, m.total)} hit rate`}
          tone="success"
        />
        <Kpi
          icon={CircleX}
          label="Dead"
          value={formatNumber(m.dead)}
          sub={`${pct(m.dead, m.total)} of checks`}
          tone="danger"
        />
        <Kpi
          icon={TriangleAlert}
          label="Errors"
          value={formatNumber(m.error)}
          sub={`${pct(m.error, m.total)} of checks`}
          tone="warning"
        />
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={Gauge} label="Avg latency" value={formatDuration(m.avgLatencyMs)} sub="Per run" tone="info" />
        <Kpi
          icon={Layers}
          label="Checks / run"
          value={m.runs > 0 ? (m.total / m.runs).toFixed(1) : "0"}
          sub="Average batch size"
        />
        <Kpi
          icon={ShieldAlert}
          label="Blocks"
          value={formatNumber(m.rateLimitBlocks)}
          sub="Rate-limit blocks"
          tone="warning"
        />
        <Kpi
          icon={Clock}
          label="Last check"
          value={mounted ? formatRelative(m.lastSeen) : m.lastSeen ? "—" : "Never"}
          sub="Most recent activity"
        />
      </section>

      {/* Free generator + audience stats. */}
      <section className="grid grid-cols-2 gap-4">
        <Kpi
          icon={Gift}
          label="Generations"
          value={formatNumber(m.generationsCompleted)}
          sub={genBreakdown || "Accounts handed out"}
          tone="success"
        />
        <Kpi icon={Users} label="Total users" value={formatNumber(m.totalUsers)} sub="Distinct visitors" tone="info" />
        <Kpi icon={Route} label="Gateway completions" value={formatNumber(m.gatewayCompletions)} sub="Successful completions" tone="success" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Check volume — last 7 days</CardTitle>
        </CardHeader>
        <CardContent>
          {m.total === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No checks recorded yet. Run a check to populate analytics.
            </p>
          ) : (
            <ChartContainer config={trendConfig} className="h-56 w-full">
              <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="fillTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
                <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey="total"
                  type="monotone"
                  stroke="var(--color-total)"
                  strokeWidth={2}
                  fill="url(#fillTotal)"
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
