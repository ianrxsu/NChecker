import type { CheckResult } from "@/lib/cookie-utils"

// Compact, refresh-proof snapshot of a bulk run, persisted to localStorage so a
// page refresh (or navigating away and back) never loses progress. We store the
// RAW cookie text + per-row status/error/result; cookie parsing and row ids are
// recomputed on load, which keeps the payload roughly half the size.
export type PersistedRow = {
  r: string // raw cookie text
  s: string // RowStatus
  e?: string // error message
  d?: CheckResult // result payload (alive/dead/error detail)
}

export type BulkSnapshot = {
  v: 1
  rows: PersistedRow[]
  // Whether a run was active when the snapshot was taken. On restore we never
  // auto-resume; we surface a paused state so the user explicitly continues.
  wasRunning: boolean
  savedAt: number
}

const PREFIX = "bulk-checker:"

function keyFor(id: string): string {
  return `${PREFIX}${id}`
}

// Persists a snapshot. Bulk runs can be large (thousands of cookies), so if we
// blow the localStorage quota we progressively shed weight: first drop the heavy
// result payloads (keeping cookies + statuses so the run can still resume), and
// if even that fails we give up silently rather than throwing into the UI.
export function saveBulkSnapshot(id: string, snapshot: BulkSnapshot): void {
  if (typeof window === "undefined") return
  const key = keyFor(id)
  try {
    window.localStorage.setItem(key, JSON.stringify(snapshot))
  } catch {
    try {
      const lite: BulkSnapshot = {
        ...snapshot,
        rows: snapshot.rows.map((row) => ({ r: row.r, s: row.s, e: row.e })),
      }
      window.localStorage.setItem(key, JSON.stringify(lite))
    } catch {
      // Out of space even without results — leave whatever was last saved.
    }
  }
}

export function loadBulkSnapshot(id: string): BulkSnapshot | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(keyFor(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as BulkSnapshot
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rows)) return null
    return parsed
  } catch {
    return null
  }
}

export function clearBulkSnapshot(id: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(keyFor(id))
  } catch {
    // ignore
  }
}
