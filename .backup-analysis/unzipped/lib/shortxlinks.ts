import { createHmac, timingSafeEqual } from "node:crypto"

const SHORTXLINKS_API = "https://shortxlinks.com/api"

export const SHORTXLINKS_MIN_DWELL_SECONDS = 8
export const SHORTXLINKS_LINK_TTL_SECONDS = 60 * 60

function signingSecret(): string {
  return (
    process.env.SHRINKEARN_SIGNING_SECRET ||
    process.env.REWARD_SIGNING_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    process.env.ADMIN_PASSWORD ||
    "cookies-mo-shortxlinks-v1"
  )
}

export function signShortXLinks(token: string, mint: number, exp: number): string {
  return createHmac("sha256", signingSecret()).update(`${token}.${mint}.${exp}`).digest("hex")
}

export function verifyShortXLinksSig(token: string, mint: number, exp: number, sig: string): boolean {
  const expected = signShortXLinks(token, mint, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function buildShortXLinksReturnUrl(origin: string, token: string): string {
  const mint = Math.floor(Date.now() / 1000)
  const exp = mint + SHORTXLINKS_LINK_TTL_SECONDS
  const sig = signShortXLinks(token, mint, exp)
  const qs = new URLSearchParams({ t: token, m: String(mint), e: String(exp), s: sig })
  return `${origin}/api/shortxlinks/return?${qs.toString()}`
}

export type ShortXLinksResult = { ok: true; url: string } | { ok: false; error: string }

export async function shortenWithShortXLinks(destinationUrl: string): Promise<ShortXLinksResult> {
  const apiToken = process.env.SHORTXLINKS_API_TOKEN
  if (!apiToken) return { ok: false, error: "not_configured" }

  const endpoint = `${SHORTXLINKS_API}?api=${encodeURIComponent(apiToken)}&url=${encodeURIComponent(destinationUrl)}`
  try {
    const res = await fetch(endpoint, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    const data = (await res.json().catch(() => null)) as
      | { status?: string; shortenedUrl?: string; message?: string }
      | null
    if (data?.status === "success" && typeof data.shortenedUrl === "string" && /^https?:\/\//.test(data.shortenedUrl)) {
      return { ok: true, url: data.shortenedUrl }
    }
    return { ok: false, error: data?.message || "shorten_failed" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "shorten_error" }
  }
}

export function shortXLinksConfigured(): boolean {
  return Boolean(process.env.SHORTXLINKS_API_TOKEN && signingSecret())
}
