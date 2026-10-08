import { NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { resetClaimLimits, markExtResetPending } from "@/lib/rate-limit"
import { resetShrinkEarnCooldown } from "@/lib/shrinkearn"
import { requestIp } from "@/lib/request-ip"
import { readDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import { receivedCookieName } from "@/lib/received-accounts"
import type { Service } from "@/lib/check-via-proxies"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST — clears every per-visitor claim limit that applies to the ADMIN'S OWN
// device/IP so they can test the generator freely without waiting out windows.
// Scoped strictly to the caller's own identity (their IP + signed device id + their
// browser cookies) — it can NEVER reset another visitor's limits or wipe global
// data. Auth-gated to admins only.
export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ip = await requestIp()
  const deviceId = await readDeviceId()
  // The admin's own fingerprint bucket, so a self-reset also clears the third bucket
  // for the website generator (the extension clears its own fp via the reset bridge).
  const fingerprint = await fingerprintFromNextHeaders(ip)

  // 1) Redis: per-service claim buckets (IP + device + fingerprint) and the ShrinkEarn cooldown.
  const clearedClaimKeys = await resetClaimLimits(ip, deviceId || undefined, fingerprint || undefined)
  const clearedCooldown = await resetShrinkEarnCooldown(ip || null)

  // 1b) Arm a pending reset for this IP so the extension clears its OWN install's
  // buckets the next time its popup checks limits. This is the robust path that works
  // even if the extId→IP mapping used by resetClaimLimits was never persisted.
  await markExtResetPending(ip)

  // 2) Browser: the per-service "already received" cookies, so the admin can be
  // granted the same pool accounts again during testing. Cleared by expiring each.
  const services: Service[] = ["netflix", "prime", "crunchyroll"]
  const res = NextResponse.json({
    ok: true,
    ip: ip || "unknown",
    hasDeviceId: Boolean(deviceId),
    clearedClaimKeys,
    clearedCooldown,
  })
  for (const service of services) {
    res.cookies.set(receivedCookieName(service), "", {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 0,
    })
  }
  return res
}
