"use client"

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { errorLabel, type CheckErrorCategory } from "@/lib/check-errors"
import type { AdminData } from "@/lib/use-admin-metrics"
import { pct } from "../shared"

const outcomeConfig = {
  alive: { label: "Alive", color: "var(--chart-1)" },
  dead: { label: "Dead", color: "var(--destructive)" },
  error: { label: "Errors", color: "var(--chart-3)" },
} satisfies ChartConfig

const claimsConfig = {
  count: { label: "Claims", color: "var(--chart-1)" },
} satisfies ChartConfig

const SERVICE_LABELS: Record<string, string> = {
  netflix: "Netflix",
  prime: "Prime",
  crunchyroll: "Crunchyroll",
}

export function AnalyticsSection({ data }: { data: AdminData }) {
  const m = data.metrics
  const claims = data.claims
  const daily = m.perDay.map((d) => ({ label: d.day.slice(5), alive: d.alive, dead: d.dead, error: d.error }))
  const hourly = m.perHour.map((h) => ({ label: h.hour.slice(11) + "h", total: h.total }))
  const hasData = m.total > 0

  const outcomePie = [
    { name: "alive", value: m.alive, fill: "var(--color-alive)" },
    { name: "dead", value: m.dead, fill: "var(--color-dead)" },
    { name: "error", value: m.error, fill: "var(--color-error)" },
  ].filter((d) => d.value > 0)

  const errorEntries = Object.entries(m.errorsByCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])

  // Only show the fully-empty state when there's neither check data NOR durable
  // claim data — otherwise the durable claims block below should still render.
  if (!hasData && !(claims.enabled && claims.total > 0)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          No analytics yet. Once checks run, charts populate here automatically.
        </CardContent>
      </Card>
    )
  }

  const claimsDaily = claims.perDay.map((d) => ({ label: d.day.slice(5), count: d.count }))

  return (
    <div className="space-y-4">
      {/* ── DURABLE CLAIM ANALYTICS (Neon Postgres) ───────────────────────── */}
      {claims.enabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Reward claims — durable history{" "}
              <span className="ml-1 rounded-md border border-border bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-foreground">
                Neon
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Summary stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Total claims", value: claims.total },
                { label: "Last 24h", value: claims.last24h },
                { label: "Last 7 days", value: claims.last7d },
                { label: "Services", value: Object.keys(claims.byService).length },
              ].map((s) => (
                <div key={s.label} className="border border-border bg-card p-3">
                  <p className="font-mono text-2xl font-bold tabular-nums text-foreground">
                    {s.value.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>

            {claims.total === 0 ? (
              <p className="text-sm text-muted-foreground">
                No claims recorded yet. Every successful account hand-out is logged here permanently.
              </p>
            ) : (
              <>
                {/* Claims per day */}
                {claimsDaily.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                      Claims per day — last 14 days (UTC)
                    </p>
                    <ChartContainer config={claimsConfig} className="h-48 w-full">
                      <BarChart data={claimsDaily} margin={{ left: 4, right: 8, top: 8 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} />
                        <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  </div>
                )}

                <div className="grid gap-6 md:grid-cols-2">
                  {/* By service */}
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">By service</p>
                    <ul className="space-y-3">
                      {Object.entries(claims.byService)
                        .sort((a, b) => b[1] - a[1])
                        .map(([svc, n]) => (
                          <li key={svc} className="flex items-center gap-3">
                            <span className="w-24 shrink-0 text-sm text-foreground">{SERVICE_LABELS[svc] ?? svc}</span>
                            <div className="h-3 flex-1 overflow-hidden rounded-md border border-border bg-card">
                              <div className="h-full bg-accent" style={{ width: pct(n, claims.total) }} />
                            </div>
                            <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
                              {n}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>

                  {/* Top countries */}
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Top regions</p>
                    <ul className="space-y-3">
                      {claims.topCountries.map((c) => (
                        <li key={c.country} className="flex items-center gap-3">
                          <span className="w-24 shrink-0 text-sm text-foreground">{c.country}</span>
                          <div className="h-3 flex-1 overflow-hidden rounded-md border border-border bg-card">
                            <div className="h-full bg-chart-2" style={{ width: pct(c.count, claims.total) }} />
                          </div>
                          <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
                            {c.count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Recent claims */}
                {claims.recent.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Recent claims</p>
                    <div className="overflow-hidden border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted">
                          <tr className="text-left">
                            <th className="px-3 py-2 font-semibold">Service</th>
                            <th className="px-3 py-2 font-semibold">Plan</th>
                            <th className="px-3 py-2 font-semibold">Region</th>
                            <th className="px-3 py-2 text-right font-semibold">When (UTC)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {claims.recent.map((r, i) => (
                            <tr key={i} className="border-t border-border/20">
                              <td className="px-3 py-2 text-foreground">{SERVICE_LABELS[r.service] ?? r.service}</td>
                              <td className="px-3 py-2 text-muted-foreground">{r.plan ?? "—"}</td>
                              <td className="px-3 py-2 text-muted-foreground">{r.country ?? "—"}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {r.createdAt.replace("T", " ").replace("Z", "")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Outcomes over 7 days (stacked) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Outcomes — last 7 days</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={outcomeConfig} className="h-60 w-full">
              <AreaChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
                <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                  dataKey="alive"
                  stackId="a"
                  type="monotone"
                  stroke="var(--color-alive)"
                  fill="var(--color-alive)"
                  fillOpacity={0.3}
                  strokeWidth={2}
                />
                <Area
                  dataKey="dead"
                  stackId="a"
                  type="monotone"
                  stroke="var(--color-dead)"
                  fill="var(--color-dead)"
                  fillOpacity={0.3}
                  strokeWidth={2}
                />
                <Area
                  dataKey="error"
                  stackId="a"
                  type="monotone"
                  stroke="var(--color-error)"
                  fill="var(--color-error)"
                  fillOpacity={0.3}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Outcome distribution donut */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Outcome distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={outcomeConfig} className="mx-auto h-60 w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                <Pie
                  data={outcomePie}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {outcomePie.map((entry) => (
                    <Cell key={entry.name} fill={entry.fill} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="name" />} />
              </PieChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* 24h hourly volume */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Hourly volume — last 24h (UTC)</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={{ total: { label: "Checks", color: "var(--chart-2)" } }} className="h-52 w-full">
            <BarChart data={hourly} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} interval={2} />
              <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="total" fill="var(--color-total)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Error breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Error breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {errorEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors recorded. Healthy upstream.</p>
          ) : (
            <ul className="space-y-3">
              {errorEntries.map(([cat, n]) => (
                <li key={cat} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 text-sm text-foreground">{errorLabel(cat as CheckErrorCategory)}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-md border border-border bg-card">
                    <div className="h-full rounded-md bg-warning" style={{ width: pct(n, m.error) }} />
                  </div>
                  <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
                    {n}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
