import { NextResponse } from "next/server"
import { isAdministrator } from "@/lib/admin-auth"
import { saveAnnouncement } from "@/lib/announcement"

export async function POST(request: Request) {
  if (!(await isAdministrator())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await request.json()
    await saveAnnouncement(String(body.message ?? ""), Number(body.durationDays))
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid announcement" }, { status: 400 })
  }
}
