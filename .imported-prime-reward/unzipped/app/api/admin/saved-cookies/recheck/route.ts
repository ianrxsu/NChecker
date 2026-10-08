import { type NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { dbEnabled } from "@/lib/db"
import { redisEnabled } from "@/lib/redis"
import {
  getSavedRecheckJob,
  isRecheckAlive,
  pauseSavedRecheckJob,
  resumeSavedRecheckJob,
  resumeStaleSavedRecheckJob,
  runSavedRecheckChunk,
  startSavedRecheckJob,
  stopSavedRecheckJob,
  triggerNextRecheckChunk,
} from "@/lib/saved-recheck-job"

export const runtime = "nodejs"
// Each invocation processes one time-budgeted chunk; chunks chain via internal
// continuation requests, so the whole recheck runs in the background.
export const maxDuration = 60

// GET — current background-recheck job state, for the admin UI's progress poll.
// Doubles as the self-healing watchdog (resumes a stale continuation chain).
export async function GET(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const origin = new URL(req.url).origin
  const job = await getSavedRecheckJob()
  if (job?.status === "running") {
    waitUntil(resumeStaleSavedRecheckJob(origin))
  }
  return NextResponse.json({ job })
}

// POST — either START a new background recheck (admin-authed) or process the
// next CHUNK of the running recheck (authed by the job-id capability token in
// the `x-saved-recheck-token` header). Body: {} for a fresh start, or
// { _continue: true } for a continuation.
export async function POST(req: NextRequest) {
  const origin = new URL(req.url).origin

  // ---- Continuation path: a self-triggered next chunk. ----
  const token = req.headers.get("x-saved-recheck-token")
  if (token) {
    const current = await getSavedRecheckJob()
    if (!current || current.id !== token) {
      // Stale/foreign token — the job moved on. Nothing to do.
      return NextResponse.json({ ok: true, skipped: true })
    }
    waitUntil(
      (async () => {
        const { done, job } = await runSavedRecheckChunk()
        if (!done && job) await triggerNextRecheckChunk(origin, job.id)
      })(),
    )
    return NextResponse.json({ ok: true })
  }

  // ---- Fresh-start path: admin only. ----
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!dbEnabled) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 })
  }
  if (!redisEnabled) {
    return NextResponse.json(
      { error: "Background recheck needs Redis. Connect Upstash for Redis to enable it." },
      { status: 503 },
    )
  }

  // ---- Control actions: pause / resume / stop the running recheck. ----
  let body: { action?: "pause" | "resume" | "stop" } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // empty body is a fresh start
  }
  if (body.action === "pause") {
    const job = await pauseSavedRecheckJob()
    return NextResponse.json({ ok: true, job })
  }
  if (body.action === "stop") {
    const job = await stopSavedRecheckJob()
    return NextResponse.json({ ok: true, job })
  }
  if (body.action === "resume") {
    const job = await resumeSavedRecheckJob()
    if (job?.status === "running") {
      waitUntil(
        (async () => {
          const { done, job: j } = await runSavedRecheckChunk()
          if (!done && j) await triggerNextRecheckChunk(origin, j.id)
        })(),
      )
    }
    return NextResponse.json({ ok: true, job })
  }

  // If a recheck is already in flight, just return it (idempotent start).
  const existing = await getSavedRecheckJob()
  if (isRecheckAlive(existing)) {
    return NextResponse.json({ started: false, alreadyRunning: true, job: existing })
  }

  const job = await startSavedRecheckJob({ source: "manual" })
  if (job.total === 0) {
    return NextResponse.json({ started: false, job: { ...job, status: "done", finishedAt: Date.now() } })
  }

  // Kick off the first chunk in the background and return immediately.
  waitUntil(
    (async () => {
      const { done, job: j } = await runSavedRecheckChunk()
      if (!done && j) await triggerNextRecheckChunk(origin, j.id)
    })(),
  )

  return NextResponse.json({ started: true, job })
}
