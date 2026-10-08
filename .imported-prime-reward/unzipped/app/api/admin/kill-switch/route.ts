import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getMaintenanceState, setMaintenanceState } from "@/lib/maintenance-mode"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET — admin polls the current kill-switch state.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const state = await getMaintenanceState()
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } })
}

// POST — flip the kill switch. Body: { enabled: boolean, message?: string }.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { enabled?: unknown; message?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "`enabled` must be a boolean" }, { status: 400 })
  }
  const message = typeof body.message === "string" ? body.message : null
  const state = await setMaintenanceState(body.enabled, message)
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } })
}
