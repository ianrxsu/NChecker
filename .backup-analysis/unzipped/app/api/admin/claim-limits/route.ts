import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getClaimLimits, setClaimLimits } from "@/lib/claim-limits"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET — admin reads the current per-service account-claim limits.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const limits = await getClaimLimits()
  return NextResponse.json({ limits }, { headers: { "Cache-Control": "no-store" } })
}

// POST — save new limits. Body: { limits: { netflix: {limit, windowSeconds}, ... } }.
// Values are sanitized/clamped in setClaimLimits, so the response always reflects
// exactly what took effect.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { limits?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  if (!body.limits || typeof body.limits !== "object") {
    return NextResponse.json({ error: "`limits` object is required" }, { status: 400 })
  }
  const limits = await setClaimLimits(body.limits as Record<string, unknown>)
  return NextResponse.json({ limits }, { headers: { "Cache-Control": "no-store" } })
}
