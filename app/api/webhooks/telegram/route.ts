import { NextResponse } from "next/server"
import { processTelegramUpdate, telegramWebhookSecret } from "@/lib/telegram-bot"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const supplied = request.headers.get("x-telegram-bot-api-secret-token")
    const expected = await telegramWebhookSecret()
    if (!supplied || supplied !== expected) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") return NextResponse.json({ ok: true })

    await processTelegramUpdate(body as Parameters<typeof processTelegramUpdate>[0])
    return NextResponse.json({ ok: true })
  } catch (error) {
    // Never make Telegram retry an update because of an application or storage
    // failure. Log only the server-side error; do not expose secrets in output.
    console.error("[telegram-webhook] request failed", error)
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "telegram-webhook" })
}
