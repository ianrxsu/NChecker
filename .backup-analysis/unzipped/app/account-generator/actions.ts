"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createRewardSession } from "@/lib/reward-store"
import { claimAllowance } from "@/lib/rate-limit"
import { requestIp } from "@/lib/request-ip"
import { getOrCreateDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import { isAccessPassMode, getPass } from "@/lib/access-pass"
import { buildGatewayUrl } from "@/lib/gateway-url"
import {
  REWARD_TOKEN_COOKIE,
  REWARD_TOKEN_MAX_AGE,
  parseRewardTokens,
  serializeRewardTokens,
} from "@/lib/reward-token-cookie"

// State returned to the selection form via useActionState. On success the action
// redirects to LootLabs (throws, never returns a state). The only state we ever
// hand back is the rate-limited block, so the UI can show a live countdown and
// keep the user from opening the gateway link at all while they're over the cap.
export type StartGenerationState =
  | { status: "idle" }
  | { status: "rate_limited"; resetMs: number; label: string; limit: number }

// Called from the selection UI. Mints a pending session bound to the chosen
// plan/country, then sends the user into the LootLabs gateway. `redirect()`
// throws by design, so this never returns.
//
// LootLabs does NOT reliably forward query parameters to its destination URL, so
// we cannot depend on `?r=<token>` surviving the round trip. Instead we persist
// the token in a first-party, HTTP-only cookie BEFORE redirecting. When the user
// returns to /reward-callback on our own domain, the cookie is still present and
// the callback reads the token from it (falling back to ?r= if the gateway did
// happen to pass it through). This makes the gateway round-trip robust.
export async function startGeneration(
  _prev: StartGenerationState,
  formData: FormData,
): Promise<StartGenerationState> {
  const planRaw = formData.get("plan")
  const countryRaw = formData.get("country")
  const serviceRaw = formData.get("service")
  const plan = typeof planRaw === "string" && planRaw !== "any" ? planRaw : null
  const country = typeof countryRaw === "string" && countryRaw !== "any" ? countryRaw : null
  // The selection UI submits which service it's generating for; the session
  // remembers it so /reward-callback distributes from the matching pool. Defaults
  // to netflix for backward compatibility with any existing form markup.
  const service = serviceRaw === "prime" ? "prime" : serviceRaw === "crunchyroll" ? "crunchyroll" : "netflix"

  // GATE: enforce the per-service claim cap BEFORE minting a session or opening
  // the LootLabs link. If this IP is already at its limit, bail out with the
  // reset time so the form can render a countdown — the user can't even start the
  // gateway flow until their window resets. This counter only counts genuinely
  // distributed accounts, so saved/claimed accounts on the device never count.
  // Mint/read the signed device id here (server action = allowed to set cookies) so
  // the cap is enforced on IP AND device — see lib/device-id.ts.
  const ip = await requestIp()
  const deviceId = await getOrCreateDeviceId()
  // Same server fingerprint bucket enforced at claim time, so the pre-gateway gate's
  // countdown matches what /reward-callback will actually allow.
  const fingerprint = await fingerprintFromNextHeaders(ip)
  const allowance = await claimAllowance(service, ip, deviceId, fingerprint)
  if (!allowance.allowed) {
    return {
      status: "rate_limited",
      resetMs: allowance.resetMs,
      label: allowance.label,
      limit: allowance.limit,
    }
  }

  // ACCESS PASS: when the admin has enabled pass mode AND this device/IP already
  // holds a valid 24h pass (earned by passing the ShrinkEarn/gateway link once), mint
  // the session ALREADY unlocked and skip the gateway — the user goes straight to the
  // account. The pass is anchored ONLY to the signed device id — NOT the IP — so a
  // user is skipped past the gateway solely because THEIR device completed the link.
  // (Anchoring to IP would unlock everyone sharing a public IP once one person did the
  // link — carrier NAT / home Wi-Fi / VPN — letting users who never did it through.)
  // The check is server-side, so a pre-unlocked row is only ever created for a genuine
  // pass holder; per-service claim limits and the consume guard are untouched.
  const passMode = await isAccessPassMode()
  const hasPass = passMode && deviceId ? (await getPass(deviceId)).valid : false

  // ACCESS PASS: in pass mode the generator itself NEVER opens a gateway. A device
  // without a valid 24h pass is sent to the dedicated /unlock page to earn one first
  // (the generator page already guards this on load; this is the belt-and-braces for
  // a stale form submit). Only genuine pass holders continue past here in pass mode.
  if (passMode && !hasPass) redirect(`/unlock?service=${service}`)

  const token = await createRewardSession(plan, country, service, hasPass ? { unlocked: true } : undefined)

  const store = await cookies()
  // Prepend this token to the recent-token list (newest first) rather than
  // overwriting, so a previously-started-but-not-yet-confirmed run isn't stranded
  // when the user starts another. /reward-callback tries every token in the list.
  const existing = parseRewardTokens(store.get(REWARD_TOKEN_COOKIE)?.value)
  store.set(REWARD_TOKEN_COOKIE, serializeRewardTokens(token, existing), {
    httpOnly: true,
    sameSite: "lax", // sent on the top-level navigation back from LootLabs
    secure: true,
    path: "/",
    maxAge: REWARD_TOKEN_MAX_AGE,
  })

  // Pass holder → straight to the callback on our own domain (no gateway URL build).
  // The session is already unlocked, so /reward-callback consumes it and distributes
  // immediately, with per-service claim limits still enforced in performClaim.
  if (hasPass) redirect("/reward-callback")

  // Non-pass mode → the original per-account gateway. buildGatewayUrl applies the
  // admin's configured provider chain (LootLabs / ShrinkEarn / oii.io) and always
  // fails safe to LootLabs. The token also rides in the first-party cookie so
  // /reward-callback can find the session on return even if the query string is
  // stripped — but distribution still REQUIRES the gateway to have unlocked it first.
  const gatewayUrl = await buildGatewayUrl(token, ip)
  redirect(gatewayUrl)
}
