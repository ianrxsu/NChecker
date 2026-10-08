import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { isAliveResult } from "@/lib/cookie-utils"
import {
  type AliveEntry,
  clearSavedCrunchyrollCookies,
  deleteSavedCrunchyrollCookie,
  listSavedCrunchyrollCookieDetails,
  loadSavedCrunchyrollCookiesByIds,
  removeSavedCrunchyrollCookies,
  saveAliveCrunchyrollCookies,
} from "@/lib/saved-crunchyroll-cookies"
import { dbEnabled } from "@/lib/db"

export const runtime = "nodejs"

// Crunchyroll variant of /api/admin/saved-cookies. Identical contract, but every
// operation targets the dedicated `saved_crunchyroll_cookies` pool so Netflix,
// Prime, and Crunchyroll accounts never mix.
async function requireAdmin(): Promise<NextResponse | null> {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!dbEnabled) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 })
  }
  return null
}

const MAX_COOKIE_LEN = 8_192

// GET — default lists accounts WITHOUT cookie blobs; ?cookies=1,2,3 returns the
// full cookie strings for those ids on demand. See saved-cookies route for details.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const cookiesParam = new URL(req.url).searchParams.get("cookies")
  if (cookiesParam !== null) {
    const ids = cookiesParam.split(",").map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ cookies: [] })
    const rows = await loadSavedCrunchyrollCookiesByIds(ids)
    return NextResponse.json({ cookies: rows.map((r) => ({ id: r.id, cookie: r.cookie })) })
  }

  const items = await listSavedCrunchyrollCookieDetails()
  return NextResponse.json({ items })
}

// POST — persist alive Crunchyroll cookies. Body: { items: [{ cookie, result }] }.
export async function POST(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  let body: { items?: AliveEntry[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 })
  }

  const incoming = Array.isArray(body.items) ? body.items : []
  const entries = incoming
    .filter((e) => e && typeof e.cookie === "string" && e.result && isAliveResult(e.result))
    .map((e) => ({ cookie: e.cookie.slice(0, MAX_COOKIE_LEN), result: e.result }))

  if (entries.length === 0) return NextResponse.json({ saved: 0 })

  const { saved } = await saveAliveCrunchyrollCookies(entries)
  return NextResponse.json({ saved })
}

// DELETE — remove one (?id=), all (?all=true), or a batch ({ ids: [...] }).
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  if (searchParams.get("all") === "true") {
    const removed = await clearSavedCrunchyrollCookies()
    return NextResponse.json({ removed })
  }

  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body!.ids.filter((v): v is string => typeof v === "string") : []
    if (ids.length > 0) {
      const removed = await removeSavedCrunchyrollCookies(ids)
      return NextResponse.json({ removed })
    }
    return NextResponse.json({ removed: 0 })
  }

  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 })
  const ok = await deleteSavedCrunchyrollCookie(id)
  return NextResponse.json({ removed: ok ? 1 : 0 })
}
