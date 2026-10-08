// Helpers for the `received_accounts` browser cookie — the list of saved-cookie
// ids a visitor has already been granted, so the distribution engine never hands
// out the same account twice. Stored as a JSON array of string ids, httpOnly so
// only the server can read/extend it (the client can't tamper to re-roll).

import type { Service } from "@/lib/check-via-proxies"

export const RECEIVED_ACCOUNTS_COOKIE = "received_accounts"
// Long-lived and independent from the 24-hour pass: claimed-account history
// remains available on this device even after the access pass expires.
export const RECEIVED_ACCOUNTS_MAX_AGE = 60 * 60 * 24 * 3650 // 10 years

// Per-service cookie name. Netflix keeps the original "received_accounts" name so
// existing visitors' history is preserved; Prime and Crunchyroll use separate
// cookies so the services' "already received" memories never collide.
export function receivedCookieName(service: Service): string {
  if (service === "prime") return "received_prime_accounts"
  if (service === "crunchyroll") return "received_crunchyroll_accounts"
  return RECEIVED_ACCOUNTS_COOKIE
}

// Parses the raw cookie value into a de-duped list of ids. Tolerates malformed
// values by returning an empty list.
export function parseReceivedAccounts(raw: string | undefined | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.map((v) => String(v))))
  } catch {
    return []
  }
}

// Serializes an id list back to the cookie value, appending `addId` if provided.
export function serializeReceivedAccounts(ids: string[], addId?: string): string {
  const set = new Set(ids.map((v) => String(v)))
  if (addId) set.add(String(addId))
  return JSON.stringify(Array.from(set))
}
