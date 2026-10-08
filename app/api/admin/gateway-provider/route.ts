import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import {
  getGatewayProvider,
  setGatewayProvider,
  isGatewayProvider,
  DEFAULT_GATEWAY_PROVIDER,
} from "@/lib/gateway-provider"
import { oiiConfigured } from "@/lib/oii"
import { shortXLinksConfigured } from "@/lib/shortxlinks"
import { getShortXRouting, setShortXRouting, getShortXRoutingStatus, type ShortXRouting } from "@/lib/shortx-routing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function shrinkEarnConfigured(): boolean {
  return Boolean(process.env.SHRINKEARN_API_TOKEN)
}

function buildStatus() {
  return {
    shrinkEarnConfigured: shrinkEarnConfigured(),
    oiiConfigured: oiiConfigured(),
    shortXLinksConfigured: shortXLinksConfigured(),
  }
}

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const provider = await getGatewayProvider()
  const shortXRouting = await getShortXRouting()
  return NextResponse.json(
    { provider, shortXRouting, ...getShortXRoutingStatus(), ...buildStatus() },
    { headers: { "Cache-Control": "no-store" } },
  )
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

  if (body.shortXRouting === "website_second" || body.shortXRouting === "website_first") {
    try {
      const saved = await setShortXRouting(body.shortXRouting as ShortXRouting)
      return NextResponse.json({ shortXRouting: saved, ...getShortXRoutingStatus() }, { headers: { "Cache-Control": "no-store" } })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save routing." }, { status: 503 })
    }
  }

  const next = body.provider
  if (!isGatewayProvider(next)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 })
  }

  try {
    const saved = await setGatewayProvider(next)
    return NextResponse.json(
      { provider: saved, ...buildStatus() },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save gateway provider."
    console.log("[v0] gateway-provider save failed:", message)
    return NextResponse.json({ error: message, fallback: DEFAULT_GATEWAY_PROVIDER }, { status: 503 })
  }
}
