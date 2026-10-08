import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getBrandColor, setBrandColor, normalizeHex } from "@/lib/brand-color"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET — current site main color.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const brand = await getBrandColor()
  return NextResponse.json(brand, { headers: { "Cache-Control": "no-store" } })
}

// POST — set the main color. Body: { color: string | null }. Passing null (or the
// default hex) resets the brand to the built-in teal.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { color?: unknown }
  try {
    body = (await req.json()) as { color?: unknown }
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const reset = body.color === null
  if (!reset && normalizeHex(body.color) === null) {
    return NextResponse.json({ error: "`color` must be a hex value like #14b8a6." }, { status: 400 })
  }

  try {
    const saved = await setBrandColor(reset ? null : (body.color as string))
    return NextResponse.json(saved, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save the color."
    console.log("[v0] brand-color save failed:", message)
    return NextResponse.json({ error: message }, { status: 503 })
  }
}
