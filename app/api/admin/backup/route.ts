import { type NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import {
  exportBackup,
  restoreNeonBegin,
  restoreNeonInsert,
  restoreNeonFinalize,
  restoreRedisBegin,
  restoreRedisChunk,
  backupDbEnabled,
  backupRedisEnabled,
  type StoreSelection,
  type RedisEntry,
} from "@/lib/backup"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Backups can touch every row/key — give the operation generous headroom.
export const maxDuration = 60

async function requireAdmin(): Promise<NextResponse | null> {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}

// Reads ?neon= / ?redis= flags (default: both). Any explicit "0"/"false" disables.
function selectionFromParams(params: URLSearchParams): StoreSelection {
  const flag = (name: string) => {
    const v = params.get(name)
    return v === null ? true : v !== "0" && v.toLowerCase() !== "false"
  }
  return { neon: flag("neon"), redis: flag("redis") }
}

// GET — export a full backup as a downloadable JSON file.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  if (!backupDbEnabled && !backupRedisEnabled) {
    return NextResponse.json({ error: "No data stores are configured to back up." }, { status: 503 })
  }

  const selection = selectionFromParams(new URL(req.url).searchParams)

  try {
    const doc = await exportBackup(selection)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
    const body = JSON.stringify(doc, null, 2)
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="backup-${stamp}.json"`,
        "Cache-Control": "no-store",
        "X-Backup-Warnings": encodeURIComponent((doc.warnings ?? []).join(" | ")),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed." },
      { status: 500 },
    )
  }
}

// POST — restore in small CHUNKS so no single request exceeds the serverless body
// limit (~4.5MB on Vercel). The client streams a restore as a sequence of actions:
//   { action: "neon-begin",    tables }          → truncate all target tables
//   { action: "neon-insert",   table, rows }      → insert one batch of rows
//   { action: "neon-finalize", tables }           → resync identity sequences
//   { action: "redis-chunk",   entries }          → restore a batch of Redis keys
// Each action REPLACES existing data in the affected store.
type RestoreAction =
  | { action: "neon-begin"; tables?: string[] }
  | { action: "neon-insert"; table?: string; rows?: Record<string, unknown>[] }
  | { action: "neon-finalize"; tables?: string[] }
  | { action: "redis-begin" }
  | { action: "redis-chunk"; entries?: RedisEntry[] }

export async function POST(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  let body: RestoreAction
  try {
    body = (await req.json()) as RestoreAction
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 })
  }

  try {
    if (!body || typeof body !== "object" || !["neon-begin", "neon-insert", "neon-finalize", "redis-begin", "redis-chunk"].includes(body.action)) {
      return NextResponse.json({ error: "Unknown restore action." }, { status: 400 })
    }
    switch (body.action) {
      case "neon-begin":
        await restoreNeonBegin(body.tables ?? [])
        return NextResponse.json({ ok: true })

      case "neon-insert": {
        if (!body.table) {
          return NextResponse.json({ error: "Missing table name." }, { status: 400 })
        }
        const rows = await restoreNeonInsert(body.table, body.rows ?? [])
        return NextResponse.json({ ok: true, rows })
      }

      case "neon-finalize":
        await restoreNeonFinalize(body.tables ?? [])
        return NextResponse.json({ ok: true })

      case "redis-begin":
        await restoreRedisBegin()
        return NextResponse.json({ ok: true })

      case "redis-chunk": {
        const res = await restoreRedisChunk(body.entries ?? [])
        return NextResponse.json({ ok: true, keys: res.keys, errors: res.errors })
      }

      default:
        return NextResponse.json({ error: "Unknown restore action." }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed." },
      { status: 500 },
    )
  }
}
