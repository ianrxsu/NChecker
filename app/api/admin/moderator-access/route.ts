import { NextResponse } from "next/server"
import { getAdminRole, isAdministrator } from "@/lib/admin-auth"
import { getModeratorAccess, updateModeratorAccess } from "@/lib/moderator-access"

export const runtime = "nodejs"

export async function GET() {
  if (!(await isAdministrator())) return NextResponse.json({ error: "Administrator access required." }, { status: 403 })
  return NextResponse.json(await getModeratorAccess())
}

export async function POST(request: Request) {
  if (!(await isAdministrator())) return NextResponse.json({ error: "Administrator access required." }, { status: 403 })
  const body = await request.json().catch(() => ({})) as { enabled?: boolean; password?: string }
  if (body.password !== undefined && body.password.trim().length < 8) {
    return NextResponse.json({ error: "Moderator password must be at least 8 characters." }, { status: 400 })
  }
  const next = await updateModeratorAccess({
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    password: body.password === undefined ? undefined : body.password.trim(),
  })
  return NextResponse.json({ enabled: next.enabled, updatedAt: next.updatedAt })
}
