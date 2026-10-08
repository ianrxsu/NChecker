import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Encryption-at-rest for saved Netflix cookies.
//
// Saved cookies are full Netflix sessions — the most sensitive data this app
// stores. We encrypt them with AES-256-GCM before they ever hit the database, so
// a leaked DB dump / snapshot / backup exposes only ciphertext, not live sessions.
//
// The key is derived from the COOKIE_ENCRYPTION_KEY env var (any string; we hash
// it to 32 bytes). If that var is NOT set, encryption is disabled and cookies are
// stored as plaintext (preserving existing behavior so the app keeps working) —
// set the var to turn protection on. Stored values are SELF-DESCRIBING via a
// version prefix, so plaintext rows written before the key existed still decrypt
// transparently after it's enabled.
// ─────────────────────────────────────────────────────────────────────────────

// Marks a value as AES-256-GCM ciphertext: "enc:v1:<base64(iv|tag|ciphertext)>".
const PREFIX = "enc:v1:"
const IV_LEN = 12 // 96-bit nonce, recommended for GCM
const TAG_LEN = 16 // GCM auth tag

const rawKey = process.env.COOKIE_ENCRYPTION_KEY
export const cookieEncryptionEnabled = Boolean(rawKey)

// Derive a stable 32-byte key from whatever secret was supplied. Using SHA-256
// means the env var can be any length/format (passphrase, base64, hex, …).
const key = rawKey ? createHash("sha256").update(rawKey).digest() : null

// Encrypts a cookie for storage. No-ops (returns the plaintext unchanged) when no
// key is configured, so storage still works without the env var set.
export function encryptCookie(plaintext: string): string {
  if (!key) return plaintext
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64")
}

// Decrypts a stored value. Values WITHOUT the prefix are treated as legacy
// plaintext and returned as-is, so old rows keep working after encryption is
// enabled. A decryption failure (wrong/rotated key, tampered data) returns an
// empty string rather than throwing, so one bad row can't crash a listing.
export function decryptCookie(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored
  if (!key) return "" // ciphertext present but no key to read it
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64")
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const data = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    return ""
  }
}
