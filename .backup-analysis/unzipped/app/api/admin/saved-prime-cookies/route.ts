import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { isAliveResult } from "@/lib/cookie-utils"
import {
  type AliveEntry,
  clearSavedPrimeCookies,
  deleteSavedPrimeCookie,
  listSavedPrimeCookieDetails,
  loadSavedPrimeCookiesByIds,
  removeSavedPrimeCookies,
  saveAlivePrimeCookies,
} from "@/lib/saved-prime-cookies"
import { dbEnabled } from "@/lib/db"

export const runtime = "nodejs"

// Prime variant of /api/admin/saved-cookies. Identical contract, but every
// operation targets the dedicated `saved_prime_cookies` pool so Netflix and
// Prime accounts never mix.
async function requireAdmin(): Promise<NextResponse | null> {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!dbEnabled) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 })
  }
  return null
}

// Full browser exports can contain hundreds of Amazon cookies and regularly exceed
// the old 8 KiB limit. Never slice cookie data: truncating JSON creates a value that
// can still be saved but can no longer be imported by Cookie-Editor.
const MAX_COOKIE_BYTES = 512 * 1024

function cookieByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

// GET — default lists accounts WITHOUT cookie blobs; ?cookies=1,2,3 returns the
// full cookie strings for those ids on demand. See saved-cookies route for details.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const cookiesParam = new URL(req.url).searchParams.get("cookies")
  if (cookiesParam !== null) {
    const ids = cookiesParam.split(",").map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ cookies: [] })
    const rows = await loadSavedPrimeCookiesByIds(ids)
    return NextResponse.json({ cookies: rows.map((r) => ({ id: r.id, cookie: r.cookie })) })
  }

  const items = await listSavedPrimeCookieDetails()
  return NextResponse.json({ items })
}

// POST — persist alive Prime cookies. Body: { items: [{ cookie, result }] }.
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
  const validEntries = incoming.filter(
    (e) => e && typeof e.cookie === "string" && e.result && isAliveResult(e.result),
  )
  const oversizedEntry = validEntries.find((e) => cookieByteLength(e.cookie) > MAX_COOKIE_BYTES)
  if (oversizedEntry) {
    return NextResponse.json(
      {
        error:
          "A Prime cookie export is larger than 512 KiB. Export only Amazon cookies and try again; no data was saved.",
      },
      { status: 400 },
    )
  }

  const entries = validEntries.map((e) => ({ cookie: e.cookie, result: e.result }))
  if (entries.length === 0) return NextResponse.json({ saved: 0 })

  const { saved } = await saveAlivePrimeCookies(entries)
  return NextResponse.json({ saved })
}

// DELETE — remove one (?id=), all (?all=true), or a batch ({ ids: [...] }).
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  if (searchParams.get("all") === "true") {
    const removed = await clearSavedPrimeCookies()
    return NextResponse.json({ removed })
  }

  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body!.ids.filter((v): v is string => typeof v === "string") : []
    if (ids.length > 0) {
      const removed = await removeSavedPrimeCookies(ids)
      return NextResponse.json({ removed })
    }
    return NextResponse.json({ removed: 0 })
  }

  const id = searchParams.get("id")
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 })
  const ok = await deleteSavedPrimeCookie(id)
  return NextResponse.json({ removed: ok ? 1 : 0 })
}
