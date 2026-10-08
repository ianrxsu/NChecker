import { NextResponse } from "next/server"
import { getCheckerVisibility } from "@/lib/checker-visibility"

export const runtime = "nodejs"

export async function GET() {
  const visibility = await getCheckerVisibility()
  return NextResponse.json(
    { autoProxyScrapeEnabled: visibility.autoProxyScrapeEnabled },
    { headers: { "Cache-Control": "no-store" } },
  )
}
