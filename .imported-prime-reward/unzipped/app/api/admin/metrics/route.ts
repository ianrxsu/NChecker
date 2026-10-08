import { NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getMetrics } from "@/lib/metrics"
import { getClaimAnalytics } from "@/lib/claim-analytics"
import { getSystemStatus } from "@/lib/system-status"
import { redisEnabled } from "@/lib/redis"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Live snapshot for the admin panel's polling (SWR). Auth-gated: returns 401 to
// anyone without a valid admin session so analytics never leak.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const [metrics, system, claims] = await Promise.all([getMetrics(), getSystemStatus(), getClaimAnalytics()])
  return NextResponse.json(
    { metrics, system, claims, redisEnabled, generatedAt: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
