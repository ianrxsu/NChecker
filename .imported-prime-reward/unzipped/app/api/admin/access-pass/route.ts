import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { isAccessPassMode, setAccessPassMode } from "@/lib/access-pass"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const enabled = await isAccessPassMode()
  return NextResponse.json({ enabled }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "`enabled` must be a boolean" }, { status: 400 })
  }

  try {
    const enabled = await setAccessPassMode(body.enabled)
    return NextResponse.json({ enabled }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save Access Pass mode."
    console.log("[v0] access-pass save failed:", message)
    return NextResponse.json({ error: message }, { status: 503 })
  }
}
