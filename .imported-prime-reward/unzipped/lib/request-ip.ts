import { headers } from "next/headers"

// Server-only helper that resolves the end-user's IP from the proxy headers Vercel
// sets. The first entry of x-forwarded-for is the real client. Returns "" when no
// IP can be determined, which the claim limiter treats as "fail open" (allowed).
// Shared by the Get-Account server action and the generator pages so the
// per-service claim limit is evaluated against the exact same identity everywhere.
export async function requestIp(): Promise<string> {
  const h = await headers()
  const xff = h.get("x-forwarded-for")
  if (xff) return xff.split(",")[0]!.trim()
  return h.get("x-real-ip")?.trim() ?? ""
}
