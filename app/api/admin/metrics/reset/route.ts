import { NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { resetMetrics } from "@/lib/metrics"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Danger-zone action: wipes all stored analytics. Auth-gated.
export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ok = await resetMetrics()
  if (!ok) {
    return NextResponse.json({ error: "Reset failed or database not configured." }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
