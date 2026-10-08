import { createHash } from "crypto"
import { headers } from "next/headers"
import type { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-COMPUTED DEVICE FINGERPRINT — the third claim-limit bucket.
//
// The claim limiter enforces THREE independent buckets (see lib/rate-limit.ts):
//   • device      — a signed id the client stores (browser cm_did / extension extId).
//                    Cleanly separates real devices, but the client can RESET it.
//   • fingerprint  — THIS module. A coarse, SERVER-derived id the client can't reset,
//                    because we compute it from request signals it doesn't control.
//   • ip           — the network, a wide pooled ceiling.
//
// The fingerprint is what makes the per-device cap resistant to the cheap bypass
// (clear cookies / reinstall the extension → fresh device id): those resets do NOT
// change the fingerprint, so the same physical device on the same connection still
// lands in the same fingerprint bucket and stays capped.
//
// It is DELIBERATELY scoped by IP. UA+language+platform ALONE are shared by millions
// (every stock "Chrome on Windows, en-US"), so an unscoped fingerprint would wrongly
// bucket unrelated people worldwide together. Folding the IP in makes it mean "this
// kind of device on this network", i.e. strictly NARROWER than the IP bucket: two
// genuinely different devices on one Wi-Fi (different OS/browser) get different
// fingerprints and each keep their own per-device allowance, while the same device
// resetting its id keeps ONE fingerprint. Two byte-identical setups on one network are
// indistinguishable from a single resetting device without a login — an accepted
// limitation of the no-account model.
// ─────────────────────────────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().slice(0, 256)
}

// Builds the fingerprint hash from its raw parts. Returns "" when there is nothing to
// fingerprint (no IP and no client hints), so the caller simply omits the bucket.
export function fingerprintFromParts(parts: { ip: string; ua: string; lang: string; platform: string }): string {
  const ua = norm(parts.ua)
  const lang = norm(parts.lang)
  const platform = norm(parts.platform)
  const ip = norm(parts.ip)
  // Require at least an IP or a UA — otherwise there's no signal worth bucketing.
  if (!ip && !ua) return ""
  const basis = [ip, ua, lang, platform].join("|")
  // 24 base64url chars ≈ 144 bits — collision-safe for a bucket key, compact in Redis.
  return createHash("sha256").update(basis).digest("base64url").slice(0, 24)
}

// From a Headers object (route handlers): pair with the already-resolved client IP.
export function fingerprintFromHeaders(h: Headers, ip: string): string {
  return fingerprintFromParts({
    ip,
    ua: h.get("user-agent") || "",
    lang: h.get("accept-language") || "",
    // sec-ch-ua-platform is a low-entropy client hint ("Windows"/"macOS"/"Android"),
    // present on Chromium; harmless when absent on other engines.
    platform: h.get("sec-ch-ua-platform") || "",
  })
}

// From a NextRequest (extension API routes).
export function fingerprintFromRequest(req: NextRequest, ip: string): string {
  return fingerprintFromHeaders(req.headers, ip)
}

// From a Server Action / RSC context (website generator + admin reset), where request
// headers are read via next/headers rather than a passed-in request.
export async function fingerprintFromNextHeaders(ip: string): Promise<string> {
  try {
    const h = await headers()
    return fingerprintFromHeaders(h as unknown as Headers, ip)
  } catch {
    return ""
  }
}
