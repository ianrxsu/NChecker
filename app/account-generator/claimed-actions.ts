"use server"

import { cookies } from "next/headers"
import { loadSavedCookiesByIds, deleteSavedCookie } from "@/lib/saved-cookies"
import { loadSavedPrimeCookiesByIds, deleteSavedPrimeCookie } from "@/lib/saved-prime-cookies"
import { loadSavedCrunchyrollCookiesByIds, deleteSavedCrunchyrollCookie } from "@/lib/saved-crunchyroll-cookies"
import { checkCrunchyrollCookieNative } from "@/lib/crunchyroll-native"
import { isAliveResult, prepareCookieForCheck } from "@/lib/cookie-utils"
import { checkNetflixWithLinks, checkPrimeSessionAliveDirect, mintNetflixLinksDirect } from "@/lib/check-via-proxies"
import { toGrantedAccount, type GrantedAccount } from "@/lib/granted-account"
import {
  RECEIVED_ACCOUNTS_MAX_AGE,
  parseReceivedAccounts,
  serializeReceivedAccounts,
  receivedCookieName,
} from "@/lib/received-accounts"
import type { Service } from "@/lib/check-via-proxies"

// The native checkers send their input VERBATIM as the HTTP `Cookie:` header — they
// do NOT parse it. Saved pool rows are stored by cookieForStorage in the account's
// ORIGINAL checked format (RAW / JSON / Netscape), and the "import cookies" buttons
// convert that to browser-importable Cookie-Editor JSON on the fly. Feeding a JSON
// or Netscape blob straight as a Cookie header is invalid and the request comes back
// inconclusive — which is exactly why rechecking a claimed account said "couldn't
// verify right now". prepareCookieForCheck re-parses ANY stored format down to the
// clean RAW `name=value; …` header the single-cookie checker uses, so claimed-account
// rechecks match the interactive checker. Falls back to the stored string if nothing
// parses (so we never turn a usable RAW cookie into an empty one).
function toCheckHeader(stored: string, service: Service): string {
  return prepareCookieForCheck(stored, service).cookie || stored
}

// Per-service pool storage + live verifier, mirroring reward-distribution. Keeps
// the claimed-account actions below service-agnostic.
function poolApi(service: Service) {
  if (service === "prime") {
    return {
      load: loadSavedPrimeCookiesByIds,
      del: deleteSavedPrimeCookie,
      // DIRECT, NO PROXY, LOGIN-ONLY recheck (checkPrimeSessionAliveDirect): the claimed
      // account's active Prime was already proven at ingestion, so we only re-confirm the
      // session is still logged in — reliable direct from any IP via Amazon's config API,
      // so no proxy is needed and a foreign account is never wrongly deleted just because
      // the storefront membership flag is absent from our datacenter IP. Only an
      // authoritative logged-out / on-hold / no-Prime marks it dead.
      check: (cookie: string) => checkPrimeSessionAliveDirect(toCheckHeader(cookie, "prime"), { includeRaw: false }),
    }
  }
  if (service === "crunchyroll") {
    return {
      load: loadSavedCrunchyrollCookiesByIds,
      del: deleteSavedCrunchyrollCookie,
      check: (cookie: string) =>
        checkCrunchyrollCookieNative(toCheckHeader(cookie, "crunchyroll"), { includeRaw: false }),
    }
  }
  return {
    load: loadSavedCookiesByIds,
    del: deleteSavedCookie,
    // Netflix "your accounts" recheck runs the SAME direct (no-proxy) path as the
    // single checker (checkNetflixWithLinks). Verdict only here — includeLinks is
    // off because a fresh nftoken is minted separately on an alive recheck (see
    // recheckClaimedAccount) so it's not wasted while just confirming liveness.
    check: (cookie: string) => checkNetflixWithLinks(toCheckHeader(cookie, "netflix"), { includeRaw: false }),
  }
}

// Live verification verdict. "dead" is reserved for AUTHORITATIVE negatives only
// (Netflix says the session is logged-out / expired) — those are safe to delete
// from the database. "unknown" covers every transient/inconclusive case (timeout,
// upstream error, bot challenge) and must NEVER trigger a delete.
export type ClaimedStatus = "alive" | "dead" | "unknown"

async function readReceived(service: Service) {
  const store = await cookies()
  return { store, ids: parseReceivedAccounts(store.get(receivedCookieName(service))?.value) }
}

function writeReceived(store: Awaited<ReturnType<typeof cookies>>, ids: string[], service: Service) {
  store.set(receivedCookieName(service), serializeReceivedAccounts(ids), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: RECEIVED_ACCOUNTS_MAX_AGE,
  })
}

// Direct (no-proxy) live check — a single account, so it can't be rate-limited.
async function verify(cookie: string, service: Service): Promise<ClaimedStatus> {
  const { result } = await poolApi(service).check(cookie)
  if (isAliveResult(result)) return "alive"
  if (result.errorCategory) return "unknown" // inconclusive → never delete
  return "dead"
}

// Returns the accounts this visitor has claimed, newest first. Read-only (no
// cookie writes) so it's safe to call during server-component render. Ids whose
// rows no longer exist in the database (e.g. purged after expiring) are simply
// omitted from the result; they're trimmed from the cookie on the next
// recheck/delete action.
export async function listClaimedAccounts(service: Service = "netflix"): Promise<GrantedAccount[]> {
  const { ids } = await readReceived(service)
  if (ids.length === 0) return []

  const rows = await poolApi(service).load(ids)
  const byId = new Map(rows.map((r) => [r.id, r]))

  // Preserve the cookie's order but show most-recent first. Links are minted in
  // parallel inside toGrantedAccount, so map → Promise.all keeps render snappy.
  const ordered = ids.filter((id) => byId.has(id)).reverse()
  return Promise.all(ordered.map((id) => toGrantedAccount(byId.get(id)!, service)))
}

// Re-checks one claimed account against Netflix. If it comes back AUTHORITATIVELY
// dead, it's purged from the database immediately (kept in the visitor's list,
// flagged expired, until they dismiss it). Transient failures report "unknown"
// and change nothing.
export async function recheckClaimedAccount(
  id: string,
  service: Service = "netflix",
): Promise<{ status: ClaimedStatus }> {
  const api = poolApi(service)
  const rows = await api.load([id])
  const row = rows[0]
  // Already gone from the DB → treat as expired/removed.
  if (!row) return { status: "dead" }

  const status = await verify(row.cookie, service)
  if (status === "dead") await api.del(id)
  // Every recheck of a still-alive Netflix account mints a FRESH nftoken (direct,
  // no proxy), bypassing the mint cache so the subsequent re-render of the "your
  // accounts" list shows a brand-new, valid auto-login link. Best-effort — a mint
  // hiccup never changes the recheck verdict.
  if (status === "alive" && service === "netflix") {
    await mintNetflixLinksDirect(toCheckHeader(row.cookie, "netflix"), true).catch(() => undefined)
  }
  return { status }
}

// Removes an account from THIS visitor's list. Always drops it from their cookie.
// Additionally, if the account verifies as expired/dead, it's also deleted from
// the database (so expired accounts get cleaned up); an alive account they remove
// from their own view is left in the database for other users.
export async function deleteClaimedAccount(
  id: string,
  service: Service = "netflix",
): Promise<{ removedFromDb: boolean }> {
  const api = poolApi(service)
  const { store, ids } = await readReceived(service)
  writeReceived(
    store,
    ids.filter((x) => x !== id),
    service,
  )

  const rows = await api.load([id])
  const row = rows[0]
  if (!row) return { removedFromDb: false } // nothing left to delete

  const status = await verify(row.cookie, service)
  if (status === "dead") {
    await api.del(id)
    return { removedFromDb: true }
  }
  return { removedFromDb: false }
}
