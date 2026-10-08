import { createHmac, timingSafeEqual } from "node:crypto"

const SHORTXLINKS_API = "https://shortxlinks.com/api"

export const SHORTXLINKS_MIN_DWELL_SECONDS = 8
export const SHORTXLINKS_LINK_TTL_SECONDS = 60 * 60
export const SHORTXLINKS_STEP_TTL_SECONDS = 60 * 60

export function shortXLinksStepKey(token: string): string {
  return `shortx:unlock-step:${token}`
}

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

export async function shortenWithShortXLinks(destinationUrl: string, apiToken = process.env.SHORTXLINKS_API_TOKEN): Promise<ShortXLinksResult> {
  if (!apiToken) return { ok: false, error: "not_configured" }

  // ShortXLinks requires a GET request with the token in `api` and the full
  // destination in `url`. Request JSON so we can reliably inspect success.
  const params = new URLSearchParams({ api: apiToken, url: destinationUrl })
  try {
    const res = await fetch(`${SHORTXLINKS_API}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json, text/plain" },
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.text()
    if (!res.ok) return { ok: false, error: `http_${res.status}` }

    let data: { status?: string; shortenedUrl?: string; message?: string } | null = null
    try {
      data = JSON.parse(body) as { status?: string; shortenedUrl?: string; message?: string }
    } catch {
      // The API can return a plain-text short URL when JSON is unavailable.
    }
    const rawCandidate = String(data?.shortenedUrl || body.trim()).trim()
    const candidate = rawCandidate
      .replace(/^['\"]+|['\"]+$/g, "")
      .replaceAll('\\\\/', "/")
      .replaceAll('\\/', "/")
      .trim()
    if (data?.status === "success" && /^https?:\/\//.test(candidate)) {
      return { ok: true, url: candidate }
    }
    if (!data && /^https?:\/\//.test(candidate)) return { ok: true, url: candidate }
    return { ok: false, error: data?.message || body.trim() || "shorten_failed" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "shorten_error" }
  }
}

export function shortXLinksConfigured(): boolean {
  return Boolean(process.env.SHORTXLINKS_API_TOKEN && signingSecret())
}
