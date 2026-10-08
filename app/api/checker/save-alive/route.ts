import { NextResponse } from "next/server"
import { saveAliveCookies } from "@/lib/saved-cookies"

const MAX_ENTRIES = 100
const MAX_COOKIE_LENGTH = 250_000

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { entries?: unknown }
    if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) {
      return NextResponse.json({ error: "Invalid entries" }, { status: 400 })
    }

    const entries = body.entries.filter((entry): entry is { cookie: string; result: Record<string, unknown> } => {
      if (!entry || typeof entry !== "object") return false
      const candidate = entry as { cookie?: unknown; result?: unknown }
      return (
        typeof candidate.cookie === "string" &&
        candidate.cookie.length > 0 &&
        candidate.cookie.length <= MAX_COOKIE_LENGTH &&
        Boolean(candidate.result) &&
        typeof candidate.result === "object"
      )
    })

    if (entries.length === 0) return NextResponse.json({ saved: 0 })
    const result = await saveAliveCookies(entries as Parameters<typeof saveAliveCookies>[0])
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: "Unable to save alive cookies" }, { status: 500 })
  }
}
