import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import {
  getCheckerVisibility,
  setCheckerVisibility,
  defaultVisibility,
  PUBLIC_CHECKER_SERVICES,
  type CheckerVisibility,
} from "@/lib/checker-visibility"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET — admin polls the current public-checker visibility config.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const vis = await getCheckerVisibility()
  return NextResponse.json(vis, { headers: { "Cache-Control": "no-store" } })
}

// POST — replace the config. Body is the full CheckerVisibility shape; we rebuild
// it defensively from primitives so a malformed payload can't corrupt the store.
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

  const next: CheckerVisibility = defaultVisibility()
  next.allHidden = Boolean(body.allHidden)
  next.smartCheckerEnabled = Boolean(body.smartCheckerEnabled)
  next.linksOnly = Boolean(body.linksOnly)
  next.netflixGeneratorLinksOnly = Boolean(body.netflixGeneratorLinksOnly)
  next.extensionHidden = Boolean(body.extensionHidden)
  next.autoProxyScrapeEnabled = body.autoProxyScrapeEnabled === undefined ? true : Boolean(body.autoProxyScrapeEnabled)
  const services = (body.services as Record<string, { hidden?: unknown; bulkHidden?: unknown }>) ?? {}
  const generators = (body.generators as Record<string, unknown>) ?? {}
  for (const svc of PUBLIC_CHECKER_SERVICES) {
    const s = services[svc] ?? {}
    next.services[svc] = { hidden: Boolean(s.hidden), bulkHidden: Boolean(s.bulkHidden) }
    next.generators[svc] = Boolean(generators[svc])
  }

  try {
    const saved = await setCheckerVisibility(next)
    return NextResponse.json(saved, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    // Surface the real reason (e.g. Redis quota exceeded / unavailable) instead of
    // pretending the save worked. 503 = storage temporarily unavailable.
    const message = err instanceof Error ? err.message : "Failed to save visibility settings."
    console.log("[v0] checker-visibility save failed:", message)
    return NextResponse.json({ error: message }, { status: 503 })
  }
}
