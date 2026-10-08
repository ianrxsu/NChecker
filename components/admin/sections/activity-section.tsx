"use client"

import { CircleCheck, CircleX, TriangleAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { CheckOutcome } from "@/lib/metrics"
import type { AdminData } from "@/lib/use-admin-metrics"
import { formatClock, formatDuration, formatRelative } from "../shared"

function OutcomeBadge({ outcome }: { outcome: CheckOutcome }) {
  if (outcome === "alive") {
    return (
      <Badge variant="outline" className="border-success/40 text-success">
        <CircleCheck className="size-3" aria-hidden /> Alive
      </Badge>
    )
  }
  if (outcome === "error") {
    return (
      <Badge variant="outline" className="border-warning/40 text-warning">
        <TriangleAlert className="size-3" aria-hidden /> Error
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-destructive/40 text-destructive">
      <CircleX className="size-3" aria-hidden /> Dead
    </Badge>
  )
}

export function ActivitySection({ data }: { data: AdminData }) {
  const events = data.metrics.recentEvents

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Recent activity</CardTitle>
        <p className="text-xs text-muted-foreground">Last {events.length} check runs (most recent first).</p>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Checks</TableHead>
                  <TableHead className="text-right text-success">Alive</TableHead>
                  <TableHead className="text-right text-destructive">Dead</TableHead>
                  <TableHead className="text-right text-warning">Err</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e, idx) => (
                  <TableRow key={`${e.ts}-${idx}`}>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatClock(e.ts)}
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={e.outcome} />
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{e.count}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-success">{e.alive}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-destructive">{e.dead}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-warning">{e.error}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {typeof e.durationMs === "number" ? formatDuration(e.durationMs) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatRelative(e.ts)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
