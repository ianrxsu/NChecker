import { NextResponse } from "next/server"
import { isAdministrator } from "@/lib/admin-auth"
import { deleteAnnouncement } from "@/lib/announcement"

export async function POST() {
  if (!(await isAdministrator())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await deleteAnnouncement()
  return NextResponse.json({ ok: true })
}
