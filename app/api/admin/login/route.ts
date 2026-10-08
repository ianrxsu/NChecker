import { type NextRequest, NextResponse } from "next/server"
import { createAdminSession, verifyPassword, adminConfigured } from "@/lib/admin-auth"
import { clientIp, loginAllowed, recordLoginFailure } from "@/lib/rate-limit"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { ok: false, message: "Admin access is not configured. Set ADMIN_PASSWORD." },
      { status: 503 },
    )
  }

  // Brute-force protection (failure-only, two-tier: 5/min burst + 20/hour
  // sustained). PEEK before touching the password so a client that has already
  // burned its failure budget is rejected without another guess being evaluated.
  const ip = clientIp(req)
  const gate = await loginAllowed(ip)
  if (!gate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((gate.resetMs - Date.now()) / 1000))
    return NextResponse.json(
      { ok: false, message: "Too many failed attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    )
  }

  let body: { password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 })
  }

  const role = body.password ? await verifyPassword(body.password) : null
  if (!role) {
    // Only wrong guesses accumulate toward the lockout, so a legitimate admin who
    // simply logs in repeatedly is never throttled — only attackers are.
    await recordLoginFailure(ip)
    return NextResponse.json({ ok: false, message: "Incorrect password." }, { status: 401 })
  }

  await createAdminSession(role)
  return NextResponse.json({ ok: true, role })
}
