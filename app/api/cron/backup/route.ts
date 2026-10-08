import { NextRequest, NextResponse } from "next/server"
import { createRollingBackup } from "@/lib/backup-storage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")
  if (!expected || authorization !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await createRollingBackup()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("[v0] Daily backup failed:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Backup failed." }, { status: 500 })
  }
}
