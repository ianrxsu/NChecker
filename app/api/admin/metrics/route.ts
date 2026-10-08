import { NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getMetrics } from "@/lib/metrics"
import { getClaimAnalytics } from "@/lib/claim-analytics"
import { getSystemStatus } from "@/lib/system-status"
import { redisEnabled } from "@/lib/redis"
import { getDailyCompletionStats } from "@/lib/daily-completion-stats"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Live snapshot for the admin panel's polling (SWR). Auth-gated: returns 401 to
// anyone without a valid admin session so analytics never leak.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const [metrics, system, claims, dailyCompletions] = await Promise.all([
    getMetrics(),
    getSystemStatus(),
    getClaimAnalytics(),
    getDailyCompletionStats(),
  ])
  return NextResponse.json(
    { metrics, system, claims, dailyCompletions, redisEnabled, generatedAt: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
