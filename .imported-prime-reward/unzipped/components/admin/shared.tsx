import type { ServiceState } from "@/lib/system-status"
import { cn } from "@/lib/utils"

export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%"
  return `${Math.round((part / whole) * 100)}%`
}

export function formatNumber(n: number): string {
  return n.toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0ms"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatRelative(ts: number | null): string {
  if (!ts) return "Never"
  // Clamp to 0: server-recorded timestamps can be a few seconds ahead of the
  // client clock, which previously produced nonsense like "-2s ago".
  const diff = Math.max(0, Date.now() - ts)
  const s = Math.round(diff / 1000)
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

const stateStyles: Record<ServiceState, { dot: string; text: string }> = {
  ok: { dot: "bg-success", text: "text-success" },
  degraded: { dot: "bg-warning", text: "text-warning" },
  off: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
}

export function StatusDot({ state, pulse = false }: { state: ServiceState; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2.5 shrink-0">
      {pulse && state === "ok" && (
        <span
          className={cn("absolute inline-flex size-full animate-ping rounded-md opacity-60", stateStyles[state].dot)}
        />
      )}
      <span
        className={cn("relative inline-flex size-2.5 rounded-md border border-foreground", stateStyles[state].dot)}
      />
    </span>
  )
}

export function stateColor(state: ServiceState): string {
  return stateStyles[state].text
}
