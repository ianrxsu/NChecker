import { cookies } from "next/headers"
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto"

// Cookie-based admin session. The cookie value is `<issuedAt>.<hmac>` where the
// HMAC is signed with ADMIN_SESSION_SECRET. No DB needed: the signature proves
// the session was minted by us, and the timestamp enforces expiry.

const COOKIE_NAME = "admin_session"
const SESSION_TTL_MS = 1000 * 60 * 60 * 8 // 8 hours

function sessionSecret(): string {
  // Fall back to the password if no dedicated secret is set, so the gate still
  // works; a dedicated ADMIN_SESSION_SECRET is strongly preferred.
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || ""
}

// Constant-time string comparison that won't leak length via early return.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Still run a comparison to keep timing roughly constant.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function verifyPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  return safeEqual(input, expected)
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex")
}

function mintToken(): string {
  const issuedAt = Date.now().toString()
  const nonce = randomBytes(8).toString("hex")
  const payload = `${issuedAt}.${nonce}`
  return `${payload}.${sign(payload)}`
}

function isTokenValid(token: string | undefined): boolean {
  if (!token) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [issuedAt, nonce, mac] = parts
  const payload = `${issuedAt}.${nonce}`
  if (!safeEqual(mac, sign(payload))) return false
  const ts = Number(issuedAt)
  if (Number.isNaN(ts)) return false
  return Date.now() - ts < SESSION_TTL_MS
}

export async function createAdminSession(): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, mintToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export async function destroyAdminSession(): Promise<void> {
  const store = await cookies()
  store.delete(COOKIE_NAME)
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const store = await cookies()
  return isTokenValid(store.get(COOKIE_NAME)?.value)
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD)
}
