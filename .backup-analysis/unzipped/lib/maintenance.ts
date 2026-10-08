import { redis, redisEnabled } from "@/lib/redis"
import { dbEnabled } from "@/lib/db"
import { startSavedRecheckJob, triggerNextRecheckChunk, getSavedRecheckJob } from "@/lib/saved-recheck-job"

// The 24h maintenance run. Triggered by Vercel Cron (works while you're offline)
// or manually from the admin. It does ONE thing now that there's no proxy DB:
//   • RE-CHECK every saved cookie against Netflix and DELETE the dead/expired.
// (Proxies are scraped + Netflix-tested live, on demand, so there's no proxy
// pool to scrape or sweep here anymore.) The heavy recheck delegates to a CHUNKED
// background job so the 60s maxDuration is never breached. The report stores the
// LIVE job ID so the UI can poll actual progress from the job record.

const REPORT_KEY = "maintenance:last"
const REPORT_TTL_S = 60 * 60 * 24 * 14 // keep the report for two weeks

export type MaintenanceReport = {
  id: string
  source: "cron" | "manual"
  startedAt: number
  finishedAt: number | null
  status: "running" | "done" | "error"
  // Snapshot values — filled from the live recheck job once it has started.
  cookies: { checked: number; alive: number; deleted: number }
  // Live job ID — set when the background recheck job is kicked off so the UI can
  // poll actual progress directly from the job record.
  recheckJobId: string | null
  error?: string
}

export async function getMaintenanceReport(): Promise<MaintenanceReport | null> {
  if (!redisEnabled) return null
  return (await redis.get<MaintenanceReport>(REPORT_KEY)) ?? null
}

async function saveReport(r: MaintenanceReport): Promise<void> {
  if (!redisEnabled) return
  await redis.set(REPORT_KEY, r, { ex: REPORT_TTL_S })
}

// Runs the full maintenance pass (saved-cookie recheck only). Returns the final
// report.
export async function runMaintenance(origin: string, source: "cron" | "manual"): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    cookies: { checked: 0, alive: 0, deleted: 0 },
    recheckJobId: null,
  }
  await saveReport(report)

  try {
    // Re-check saved cookies. Requires both DB (to list / delete cookies) and
    // Redis (to store job state).
    if (dbEnabled && redisEnabled) {
      try {
        const rc = await startSavedRecheckJob({ source })
        report.recheckJobId = rc.id
        report.cookies.checked = rc.total
        await saveReport(report)
        if (rc.total > 0) await triggerNextRecheckChunk(origin, rc.id)
      } catch (e) {
        console.error("[maintenance] cookie recheck start failed:", e instanceof Error ? e.message : e)
      }
    }

    report.status = "done"
  } catch (e) {
    report.status = "error"
    report.error = e instanceof Error ? e.message : "maintenance failed"
  }

  report.finishedAt = Date.now()
  await saveReport(report)
  return report
}

// Enriches a maintenance report with live stats from the background recheck job.
// Called by the GET route so the admin UI always sees up-to-date numbers even
// after the maintenance function itself has returned.
export async function enrichReportWithJobStats(report: MaintenanceReport): Promise<MaintenanceReport> {
  if (!redisEnabled) return report

  const enriched = { ...report }

  if (report.recheckJobId) {
    try {
      const job = await getSavedRecheckJob()
      if (job && job.id === report.recheckJobId) {
        enriched.cookies = {
          checked: job.total,
          alive: job.alive,
          deleted: job.deleted,
        }
      }
    } catch {
      // best-effort
    }
  }

  return enriched
}
