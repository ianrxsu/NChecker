import { type NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { dbEnabled } from "@/lib/db"
import { getMaintenanceReport, enrichReportWithJobStats, runMaintenance } from "@/lib/maintenance"
import { getSavedRecheckJob } from "@/lib/saved-recheck-job"

export const runtime = "nodejs"
export const maxDuration = 60

// GET — serves a dual purpose:
//   • Vercel Cron hits this on schedule (daily). Cron requests carry an
//     `Authorization: Bearer <CRON_SECRET>` header, which we verify.
//   • The admin UI polls it (cookie-authed) to show the last maintenance report.
// A cron hit STARTS the maintenance run in the background; an admin poll just
// returns the latest report.
export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin
  const auth = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const isCron = Boolean(cronSecret && auth === `Bearer ${cronSecret}`)

  if (isCron) {
    if (!dbEnabled) {
      return NextResponse.json({ error: "Database is not configured." }, { status: 503 })
    }
    // Run in the background so the cron invocation returns immediately.
    waitUntil(runMaintenance(origin, "cron"))
    return NextResponse.json({ ok: true, started: true })
  }

  // Otherwise treat as an admin status poll.
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const rawReport = await getMaintenanceReport()
  // Enrich the stored report with live stats from the background jobs so the UI
  // always shows up-to-date cookie / proxy numbers even after the maintenance
  // function itself has returned.
  const report = rawReport ? await enrichReportWithJobStats(rawReport) : null

  // Also surface the raw recheck-job state so the UI can show a live progress bar.
  const recheckJob = await getSavedRecheckJob().catch(() => null)

  // The maintenance report status is "done" after the maintenance function
  // returns, but the recheck job may still be chunking. Tell the UI whether it's
  // still live so it can keep polling.
  const childJobsAlive = recheckJob?.status === "running"

  return NextResponse.json({ report, recheckJob, childJobsAlive })
}

// POST — manual trigger from the admin UI ("Run now"). Starts the maintenance
// pass in the background and returns immediately.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!dbEnabled) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 })
  }
  const origin = new URL(req.url).origin

  const existing = await getMaintenanceReport()
  if (existing?.status === "running" && Date.now() - existing.startedAt < 10 * 60_000) {
    return NextResponse.json({ started: false, alreadyRunning: true, report: existing })
  }

  waitUntil(runMaintenance(origin, "manual"))
  return NextResponse.json({ started: true })
}
