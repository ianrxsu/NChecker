import { cookies } from "next/headers"
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto"

// Cookie-based admin session. The cookie value is `<issuedAt>.<hmac>` where the
// HMAC is signed with ADMIN_SESSION_SECRET. No DB needed: the signature proves
// the session was minted by us, and the timestamp enforces expiry.

const COOKIE_NAME = "admin_session"
export type AdminRole = "admin" | "moderator"
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

export async function verifyPassword(input: string): Promise<AdminRole | null> {
  if (process.env.ADMIN_PASSWORD && safeEqual(input, process.env.ADMIN_PASSWORD)) return "admin"
  const { getModeratorPassword, isModeratorEnabled } = await import("@/lib/moderator-access")
  if (await isModeratorEnabled()) {
    const moderatorPassword = await getModeratorPassword()
    if (moderatorPassword && safeEqual(input, moderatorPassword)) return "moderator"
  }
  return null
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex")
}

function mintToken(role: AdminRole): string {
  const issuedAt = Date.now().toString()
  const nonce = randomBytes(8).toString("hex")
  const payload = `${issuedAt}.${nonce}.${role}`
  return `${payload}.${sign(payload)}`
}

function tokenRole(token: string | undefined): AdminRole | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 4) return null
  const [issuedAt, nonce, role, mac] = parts
  if (role !== "admin" && role !== "moderator") return null
  const payload = `${issuedAt}.${nonce}.${role}`
  if (!safeEqual(mac, sign(payload))) return null
  const ts = Number(issuedAt)
  if (Number.isNaN(ts) || Date.now() - ts >= SESSION_TTL_MS) return null
  return role
}

export async function createAdminSession(role: AdminRole): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, mintToken(role), {
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

export async function getAdminRole(): Promise<AdminRole | null> {
  const store = await cookies()
  const role = tokenRole(store.get(COOKIE_NAME)?.value)
  if (role === "moderator") {
    const { isModeratorEnabled } = await import("@/lib/moderator-access")
    if (!(await isModeratorEnabled())) return null
  }
  return role
}

export async function isAdminAuthenticated(): Promise<boolean> {
  return (await getAdminRole()) !== null
}

export async function isAdministrator(): Promise<boolean> {
  return (await getAdminRole()) === "admin"
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD)
}
