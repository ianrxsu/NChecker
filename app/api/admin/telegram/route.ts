import { NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { getTelegramWebhookSecret, setTelegramWebhookSecret, clearTelegramWebhookSecret } from "@/lib/telegram-settings"

export const runtime = "nodejs"

export async function GET() {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ configured: Boolean(await getTelegramWebhookSecret()) })
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json().catch(() => null)
  const secret = body && typeof body === "object" && "secret" in body && typeof body.secret === "string" ? body.secret : ""
  try {
    await setTelegramWebhookSecret(secret)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save secret." }, { status: 400 })
  }
}

export async function DELETE() {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await clearTelegramWebhookSecret()
  return NextResponse.json({ ok: true })
}
