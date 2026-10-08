import { NextResponse } from "next/server"
import { performClaim, type ClaimResult } from "@/lib/reward-claim"

// Live verification through the proxy pool can take a few seconds.
export const maxDuration = 60
export const dynamic = "force-dynamic"

// Stable POST endpoint for the reward claim. Using an API route (fixed URL) rather
// than a React Server Action is deliberate: the claim screen polls this every few
// seconds, and Server Actions are re-keyed with a new hashed ID on every deploy —
// a tab/bundle from a previous deploy would POST a now-missing action ID and get an
// uncatchable HTTP 500 on every poll. A route handler has a constant URL, so it can
// never fall out of sync with the deployment.
export async function POST(req: Request): Promise<NextResponse<ClaimResult>> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tokens?: unknown
      token?: unknown
      service?: unknown
    }
    const tokens = Array.isArray(body.tokens)
      ? body.tokens.filter((t): t is string => typeof t === "string")
      : typeof body.token === "string"
        ? [body.token]
        : []
    // Scope the claim to the generator's service so a stale token from another
    // service's pool (the reward-token cookie is shared) can never be consumed here.
    const expectedService =
      body.service === "prime" || body.service === "crunchyroll" || body.service === "netflix"
        ? body.service
        : undefined
    const result = await performClaim(tokens, expectedService)
    return NextResponse.json(result)
  } catch (err) {
    // Any unexpected error becomes a polite "pending" so the client keeps polling
    // instead of showing a false hard failure. The session is single-use server
    // side, so retrying can never double-grant.
    console.log("[v0] /api/reward/claim error (returning pending):", err)
    return NextResponse.json({ ok: false, error: "pending" })
  }
}
