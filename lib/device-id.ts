import { cookies } from "next/headers"
import { createHmac, randomUUID, timingSafeEqual } from "crypto"

// A signed, HTTP-only website device cookie used as the claim-limit identity.
// It is intentionally separate from the Telegram user identity so website and bot
// access passes and usage windows cannot share state.
// On its own a device id is trivially reset (clear cookies) and an
// IP is trivially rotated (VPN / mobile data) — but requiring BOTH to be under the
// cap means a user must rotate their IP AND clear cookies on every single claim to
// keep bypassing the limit. The value is HMAC-signed so it can't be forged into
// many fake ids; clearing it just yields a brand-new id that the IP bucket still
// governs.

const DEVICE_COOKIE = "cm_did"
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

// Signing key. Falls back through a couple of project secrets, then a constant so
// the feature still works in local/demo dev (where signing is non-critical).
function signingKey(): string {
  return process.env.REWARD_SIGNING_SECRET || process.env.ADMIN_PASSWORD || "cookies-mo-device-id-v1"
}

function sign(id: string): string {
  return createHmac("sha256", signingKey()).update(id).digest("base64url")
}

// Returns the raw id only when the signature verifies, otherwise null.
function verify(value: string | undefined): string | null {
  if (!value) return null
  const dot = value.lastIndexOf(".")
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = sign(id)
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  return id
}

// READ-ONLY: returns the verified device id if a valid cookie is present, else "".
// Safe to call during a Server Component render (it never tries to set a cookie).
export async function readDeviceId(): Promise<string> {
  const store = await cookies()
  return verify(store.get(DEVICE_COOKIE)?.value) ?? ""
}

// Returns the verified device id, MINTING and setting a fresh signed cookie when
// one is missing/invalid. Only call from a Server Action or Route Handler, where
// setting cookies is allowed (a page render cannot set cookies).
export async function restoreDeviceId(deviceId: string): Promise<string> {
  const store = await cookies()
  store.set(DEVICE_COOKIE, `${deviceId}.${sign(deviceId)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  })
  return deviceId
}

export async function getOrCreateDeviceId(): Promise<string> {
  const store = await cookies()
  const existing = verify(store.get(DEVICE_COOKIE)?.value)
  if (existing) return existing

  const id = randomUUID()
  store.set(DEVICE_COOKIE, `${id}.${sign(id)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  })
  return id
}
