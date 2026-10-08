import { NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { markRewardUnlocked } from "@/lib/reward-store"
import { postbackRejectAllowed, recordPostbackReject } from "@/lib/rate-limit"

// LootLabs server-to-server POSTBACK endpoint.
//
// LootLabs calls this URL (configured in the link's Advanced > Postback settings)
// the moment a user GENUINELY completes the gateway, appending:
//   - click_id   → the `puid` we attached to the link == our reward token
//   - unique_id  → a one-time id for the completion (replay protection)
//   - ip         → the completer's IP (logged for fraud review)
//
// Only this server-verified callback flips a session to unlocked=true; the
// /reward-callback page refuses to distribute until it does. That closes the
// "skip the gateway, hit /reward-callback directly" bypass, because the cookie
// alone is no longer sufficient — a real LootLabs completion is required.
//
// Configure the postback URL in LootLabs as:
//   https://<your-domain>/api/lootlabs/postback?secret=<LOOTLABS_POSTBACK_SECRET>
// LootLabs then appends &click_id=...&unique_id=...&ip=... automatically.

export const dynamic = "force-dynamic"

// Trims a param and discards unsubstituted LootLabs macros. If the gateway didn't
// replace a placeholder, the value arrives as a literal like "{UNIQUE_ID}" — never
// a real value — so we treat anything still wrapped in {curly braces} as empty.
function clean(value: string | null): string {
  const v = (value ?? "").trim()
  if (!v) return ""
  if (/^\{.*\}$/.test(v)) return ""
  return v
}

// Constant-time secret comparison so the endpoint can't be probed via timing.
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function handle(params: URLSearchParams, fallbackIp: string | null): Promise<Response> {
  const expected = process.env.LOOTLABS_POSTBACK_SECRET

  // Fail CLOSED: with no configured secret, accept nothing. This prevents an
  // unsecured endpoint from unlocking sessions if the env var is missing.
  if (!expected) {
    console.log("[v0] LootLabs postback: LOOTLABS_POSTBACK_SECRET not set — rejecting")
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 })
  }

  // Block IPs that keep sending wrong secrets. A genuine LootLabs server always has
  // the correct secret, so repeated invalid attempts from one IP are illegitimate by
  // definition — this cheaply shuts down automated secret-guessing. Peek first so a
  // real completion is never charged against the reject budget.
  if (!(await postbackRejectAllowed(fallbackIp ?? ""))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 })
  }

  const secret = params.get("secret") ?? ""
  if (!secretMatches(secret, expected)) {
    await recordPostbackReject(fallbackIp ?? "")
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 })
  }

  // LootLabs sends the token back as `click_id` (it mirrors the `puid` we set on
  // the link). Accept a few aliases defensively.
  const token = clean(params.get("click_id")) || clean(params.get("puid")) || clean(params.get("data1")) || ""
  // If a macro wasn't substituted by LootLabs (e.g. the URL still has the literal
  // "{UNIQUE_ID}"), treat it as absent. Storing a literal placeholder as the
  // replay key would let only the first-ever completion through and reject the
  // rest as duplicates against the UNIQUE constraint.
  const uniqueId = clean(params.get("unique_id")) || null
  const ip = clean(params.get("ip")) || fallbackIp

  if (!token) {
    return NextResponse.json({ ok: false, error: "missing_click_id" }, { status: 400 })
  }

  const unlocked = await markRewardUnlocked(token, uniqueId, ip)
  if (unlocked) void import("@/lib/metrics").then(({ recordGatewayCompletion }) => recordGatewayCompletion())
  if (!unlocked) {
    // Unknown/already-consumed token or a replayed unique_id. Return 200 so
    // LootLabs doesn't keep retrying, but signal that nothing changed.
    return NextResponse.json({ ok: true, unlocked: false })
  }

  return NextResponse.json({ ok: true, unlocked: true })
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  return fwd ? fwd.split(",")[0]!.trim() : null
}

// LootLabs uses GET for postbacks; support POST too in case the dashboard is set
// to POST or sends form-encoded params.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  return handle(url.searchParams, clientIp(req))
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const params = new URLSearchParams(url.searchParams)
  const contentType = req.headers.get("content-type") ?? ""
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const body = new URLSearchParams(await req.text())
      body.forEach((v, k) => {
        if (!params.has(k)) params.set(k, v)
      })
    } catch {
      // ignore malformed bodies — query params still apply
    }
  }
  return handle(params, clientIp(req))
}
