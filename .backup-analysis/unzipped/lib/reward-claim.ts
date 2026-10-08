import { cookies, headers } from "next/headers"
import { waitUntil } from "@vercel/functions"
import {
  consumeRewardSession,
  consumeUnlockedSessionByIp,
  consumePassSession,
  consumeUnlockedPassSessionByIp,
  findGrantedSessionByIp,
  setRewardGrant,
  getRewardSessionState,
} from "@/lib/reward-store"
import { distributeAccount } from "@/lib/reward-distribution"
import { loadSavedCookiesByIds } from "@/lib/saved-cookies"
import { loadSavedPrimeCookiesByIds } from "@/lib/saved-prime-cookies"
import { loadSavedCrunchyrollCookiesByIds } from "@/lib/saved-crunchyroll-cookies"
import { toGrantedAccount, type GrantedAccount } from "@/lib/granted-account"
import { claimAllowance, recordClaim } from "@/lib/rate-limit"
import { getAccessCodeLimits } from "@/lib/access-codes"
import { getTemporaryPassLimits } from "@/lib/claim-limits"
import { getOrCreateDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import {
  isAccessPassMode,
  grantPass,
  getPass,
  passMintAllowed,
  recordPassMint,
  PASS_TTL_SECONDS,
} from "@/lib/access-pass"
import { recordGeneration, recordUser } from "@/lib/metrics"
import { recordClaimEvent } from "@/lib/claim-analytics"
import { REWARD_TOKEN_COOKIE, REWARD_TOKEN_MAX_AGE, serializeRewardTokens } from "@/lib/reward-token-cookie"
import {
  RECEIVED_ACCOUNTS_MAX_AGE,
  parseReceivedAccounts,
  serializeReceivedAccounts,
  receivedCookieName,
} from "@/lib/received-accounts"
import type { GeneratorService as Service } from "@/lib/check-via-proxies"

// Loads a saved row by id from the pool that matches the service, so a refresh
// re-displays the SAME account from the correct (Netflix vs Prime) table.
async function loadGrant(grantedId: string, service: Service): Promise<GrantedAccount | null> {
  const rows =
    service === "prime"
      ? await loadSavedPrimeCookiesByIds([grantedId])
      : service === "crunchyroll"
        ? await loadSavedCrunchyrollCookiesByIds([grantedId])
        : await loadSavedCookiesByIds([grantedId])
  // freshLinks: every time the reward-callback re-displays the granted account we
  // mint a BRAND-NEW nftoken (direct, no proxy) so the auto-login link is never a
  // stale/expired token — this is the reward-callback "valid session" guarantee.
  return rows[0] ? await toGrantedAccount(rows[0], service, { freshLinks: true }) : null
}

// "pending" = the LootLabs postback confirming completion hasn't arrived yet; the
// client should retry shortly. "invalid" = no/unknown token. "empty" = pool
// exhausted for the selection.
export type ClaimResult =
  | { ok: true; account: GrantedAccount }
  // Access Pass unlock: the /unlock gateway completion granted a 24h device pass and
  // handed out NO account. `expiresAt` is the pass expiry (ms epoch) for the UI.
  | { ok: true; pass: { expiresAt: number } }
  | { ok: false; error: "invalid" | "empty" | "pending" }
  // The IP hit this service's per-window account cap. `resetMs` is when the
  // window clears and `label` is a human string like "3 per hour" for the UI.
  | { ok: false; error: "rate_limited"; resetMs: number; label: string }

// Resolves the end-user's IP from the proxy headers Vercel sets. The first entry
// of x-forwarded-for is the real client; we match it against the IP LootLabs
// recorded in the completion postback to recover a session when the cookie is lost.
async function getClientIp(): Promise<string> {
  const h = await headers()
  const xff = h.get("x-forwarded-for")
  if (xff) return xff.split(",")[0]!.trim()
  return h.get("x-real-ip")?.trim() ?? ""
}

// Core claim logic, shared by the API route (primary) and the legacy server
// action. Implemented as a plain async function (NOT a server action) so it can be
// invoked from a stable API endpoint — that avoids the Server-Action-ID rehashing
// that makes a polled action throw uncatchable 500s after every redeploy.
export async function performClaim(
  tokensInput: string | string[],
  expectedService?: Service,
): Promise<ClaimResult> {
  let accessCodeId: number | undefined
  const store = await cookies()
  // Accept either a single token (legacy callers) or the recent-token list.
  const tokenList = (Array.isArray(tokensInput) ? tokensInput : [tokensInput])
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)

  // ---- PRIMARY PATH: try every recent token --------------------------------
  // Users often start the gateway more than once, so the genuinely-unlocked token
  // may be any of the recent ones — not necessarily the newest. We scan them all:
  //   • already consumed + has a grant → re-show it (refresh-safe), OR
  //   • unlocked & pending → atomically consume it (single-use).
  // The postback unlocked exactly one of these tokens, so this resolves the claim
  // independent of IP (which rotates on mobile) and of which start was last.
  // ---- PASS 1: classify the recent tokens -----------------------------------
  // We split the tokens into two buckets WITHOUT acting yet:
  //   • readyTokens  → newly unlocked, awaiting consumption (a brand-new claim).
  //   • reDisplayRef → the most-recent token that's already "used" with a grant
  //     (front of the list = newest), used for refresh-safe re-display.
  //
  // CRITICAL: we must NOT return the re-display grant while a ready token exists.
  // The reward-token cookie accumulates every token, so an old used+grant token is
  // always present after the first claim. Returning it eagerly meant every later
  // claim re-showed the FIRST account instead of consuming the freshly-unlocked
  // token for a new one — the "always the same account" bug. Re-display is deferred
  // below and only fires when there is nothing new to consume.
  const readyTokens: string[] = []
  let reDisplayRef: { grantedId: string; service: Service } | null = null
  // ACCESS PASS: pass-only unlock sessions minted by /unlock. Classified here and
  // handled by their own branch below — independent of the service filter, since a
  // 24h pass isn't tied to a single generator pool.
  const readyPassTokens: string[] = []
  let passUsedExists = false
  for (const token of tokenList) {
    const state = await getRewardSessionState(token)
    if (state.state === "missing") continue
    if (state.purpose === "pass") {
      if (state.state === "ready") readyPassTokens.push(token)
      else if (state.state === "used") passUsedExists = true
      continue
    }
    // When the caller declares which service it's claiming for, ignore any token
    // bound to a different pool — the reward-token cookie is shared across the
    // Netflix/Prime/Crunchyroll generators, so without this a stale token from one
    // service could be consumed (and its account handed out) on another's page.
    if (expectedService && state.service !== expectedService) continue
    if (state.state === "ready") {
      readyTokens.push(token)
    } else if (!reDisplayRef && state.state === "used" && state.grantedId) {
      reDisplayRef = { grantedId: state.grantedId, service: state.service }
    }
  }

  // Resolve the client IP once — reused for the per-service claim cap and the
  // cookie-loss IP fallback below.
  let ip = ""
  try {
    ip = await getClientIp()
  } catch {
    ip = ""
  }

  // Resolve the signed device id (second claim-limit identity alongside the IP).
  // Best-effort: a failure here must never block a genuine claim.
  let deviceId = ""
  try {
    deviceId = await getOrCreateDeviceId()
  } catch {
    deviceId = ""
  }

  // Resolve the server fingerprint (third claim-limit bucket) — the same one the
  // extension pick routes enforce. Survives a cleared cm_did cookie, so clearing
  // cookies alone no longer resets the per-device cap. Best-effort.
  const fingerprint = await fingerprintFromNextHeaders(ip)

  // ---- RE-DISPLAY (only when NOTHING new is ready to consume) ---------------
  // With no ready token, this poll is a refresh or a lost-cookie recovery — re-show
  // the account already earned, NEVER rate-limited. We try the token grant first
  // (most-recent, deferred from PASS 1), then fall back to IP-based recovery for the
  // case where the reward-token cookie didn't survive the round trip.
  //
  // When a ready token DOES exist we skip ALL of this and fall through to consume
  // it, so each completed claim yields a fresh, different account.
  if (readyTokens.length === 0) {
    if (reDisplayRef) {
      const existing = await loadGrant(reDisplayRef.grantedId, reDisplayRef.service)
      if (existing) return { ok: true, account: existing }
    }
    if (ip) {
      try {
        const granted = await findGrantedSessionByIp(ip, 60, expectedService)
        if (granted) {
          const existing = await loadGrant(granted.grantedId, granted.service)
          if (existing) return { ok: true, account: existing }
        }
      } catch (err) {
        console.log("[v0] reward IP re-display failed (non-fatal):", err)
      }
    }
  }

  // ---- ACCESS PASS unlock (no account handed out) ---------------------------
  // Only when there's no fresh ACCOUNT claim to consume (account claims always win).
  // A ready pass token means the user just completed the gateway on /unlock → consume
  // it single-use and grant the 24h device pass. A used pass token (refresh after a
  // successful unlock) re-confirms success without re-granting. grantPass is ONLY
  // called after a genuine consume/recovery, so a pass can never be minted for a user
  // who didn't complete the gateway. The pass is device-only (never IP), matching the
  // per-account grant path. Claim limits are untouched — the pass only removes the
  // gateway, it never lifts the per-service caps.
  if (readyTokens.length === 0) {
    // A "used" pass token means this is a refresh AFTER a pass was already minted —
    // re-confirm success idempotently, never re-charge the mint cap or re-consume.
    if (passUsedExists) {
      let expiresAt: number | null = null
      if (deviceId) {
        try {
          expiresAt = (await getPass(deviceId)).expiresAt ?? (await grantPass(deviceId))
        } catch (err) {
          console.log("[v0] access-pass refresh grant failed (non-fatal):", err)
        }
      }
      return { ok: true, pass: { expiresAt: expiresAt ?? Date.now() + PASS_TTL_SECONDS * 1000 } }
    }

    // A NEW mint (consuming a freshly-unlocked pass session). Gate on the per-IP
    // daily pass-mint ceiling BEFORE consuming, so a blocked user's genuine unlock
    // isn't burned — the session stays 'ready' and mints once the window clears.
    // Fails OPEN inside passMintAllowed, so a Redis blip never wrongly blocks.
    const canMint = ip ? await passMintAllowed(ip) : true
    if (!canMint) {
      return {
        ok: false,
        error: "rate_limited",
        resetMs: Date.now() + PASS_TTL_SECONDS * 1000,
        label: "too many unlocks from this network",
      }
    }

    let passUnlocked = false
    for (const token of readyPassTokens) {
      if (await consumePassSession(token)) passUnlocked = true
    }
    // Cookie-loss recovery: the {IP} on the gateway completion lets us find THIS
    // device's just-unlocked pass session when the reward-token cookie didn't survive
    // the round trip. Only matches purpose='pass' rows, so account users are untouched.
    if (!passUnlocked && ip) {
      try {
        if (await consumeUnlockedPassSessionByIp(ip, 60)) passUnlocked = true
      } catch (err) {
        console.log("[v0] pass IP fallback failed (non-fatal):", err)
      }
    }
    if (passUnlocked) {
      let expiresAt: number | null = null
      if (deviceId) {
        try {
          expiresAt = await grantPass(deviceId)
        } catch (err) {
          console.log("[v0] access-pass grant (unlock) failed (non-fatal):", err)
        }
  if (expiresAt == null) {
  try {
  const passState = await getPass(deviceId)
  expiresAt = passState.expiresAt
  accessCodeId = passState.accessCodeId
          } catch {
            expiresAt = null
          }
        }
      }
      // Charge the per-IP mint window only now that a pass was genuinely minted.
      if (ip) await recordPassMint(ip)
      return { ok: true, pass: { expiresAt: expiresAt ?? Date.now() + PASS_TTL_SECONDS * 1000 } }
    }
  }

  // ---- RATE LIMIT: per service, per IP --------------------------------------
  // Gate ONLY the unlocking of a brand-new account (Netflix 3/hr, Prime &
  // Crunchyroll 2/day). We check BEFORE consuming so a genuine LootLabs completion
  // isn't wasted when the user is over their cap — their token stays unlocked and
  // they can claim once the window resets.
  const passState = deviceId ? await getPass(deviceId) : { valid: false, expiresAt: null }
  // Lifetime code passes keep their access-code ID in Redis. Recover it here before
  // choosing the temporary/free fallback, so lifetime users always use their own
  // administrator-configured limits instead of the global free-user limits.
  accessCodeId = accessCodeId ?? passState.accessCodeId
  const codeOverride = accessCodeId && expectedService
    ? await getAccessCodeLimits(accessCodeId, expectedService)
    : null
  const passOverride = passState.valid && expectedService && !codeOverride
    ? await getTemporaryPassLimits(expectedService)
    : null
  if (expectedService && (ip || deviceId)) {
    const allowance = await claimAllowance(expectedService, ip, deviceId, fingerprint, codeOverride ?? passOverride ?? undefined)
    if (!allowance.allowed) {
      return { ok: false, error: "rate_limited", resetMs: allowance.resetMs, label: allowance.label }
    }
  }

  // ---- CONSUME: try every ready token, then the IP fallback -----------------
  let session = null
  for (const token of readyTokens) {
    session = await consumeRewardSession(token)
    if (session) break
  }
  // Rescues the rarer case where the cookie didn't survive the LootLabs round trip
  // (in-app browser, new tab, stripped cookie). Best-effort; wrapped so a failure
  // here can NEVER break the primary claim.
  if (!session && ip) {
    try {
      session = await consumeUnlockedSessionByIp(ip, 60, expectedService)
    } catch (err) {
      console.log("[v0] reward IP fallback failed (non-fatal):", err)
    }
  }

  if (!session) {
    // Nothing consumable yet → the postback for this token hasn't landed. Tell the
    // client to keep polling rather than failing hard; the unlock typically arrives
    // within a minute or two and the next poll will consume it.
    return { ok: false, error: "pending" }
  }

  // Everything from here is scoped to the SERVICE the consumed session targeted,
  // so Netflix and Prime draw from separate pools and separate "already received"
  // cookies and never cross-contaminate.
  const service = session.service
  const receivedCookie = receivedCookieName(service)
  const received = parseReceivedAccounts(store.get(receivedCookie)?.value)

  const account = await distributeAccount({
    plan: session.plan,
    country: session.country,
    receivedIds: received,
    service,
  })

  if (!account) return { ok: false, error: "empty" }

  // Bind the grant to the ACTUAL consumed token and keep that token at the FRONT of
  // the cookie list so a later refresh re-displays the same account (its state is
  // now "used" + grant). Also remember it so this user never gets it again.
  await setRewardGrant(session.token, account.id)
  store.set(REWARD_TOKEN_COOKIE, serializeRewardTokens(session.token, tokenList), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: REWARD_TOKEN_MAX_AGE,
  })
  store.set(receivedCookie, serializeReceivedAccounts(received, account.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: RECEIVED_ACCOUNTS_MAX_AGE,
  })

  // Charge ONE slot against this IP's per-service window — only now that an account
  // was genuinely handed out. This is anti-abuse, so we AWAIT it: the slot must be
  // durably charged before we return, otherwise a serverless freeze after the
  // response could drop the write and let a user claim again. Analytics writes are
  // non-critical, so they ride waitUntil (kept alive past the response, never bare
  // `void` which Vercel drops on suspend).
  if (ip || deviceId) await recordClaim(service, ip, deviceId, fingerprint, codeOverride ?? undefined)
  // ACCESS PASS: in pass mode, a genuine hand-out earns THIS DEVICE a 24h pass so its
  // subsequent claims skip the gateway. The pass is device-only (never IP) so it can't
  // leak to others sharing the same public IP. grantPass NX-anchors it to the FIRST
  // completion and never extends it on later claims. Best-effort; never breaks claim.
  if (deviceId) {
    try {
      if (await isAccessPassMode()) await grantPass(deviceId)
    } catch (err) {
      console.log("[v0] access-pass grant failed (non-fatal):", err)
    }
  }
  waitUntil(recordGeneration(service))
  if (ip) waitUntil(recordUser(ip))
  // Durable, low-frequency record of the hand-out (Neon). No IP/user data — just
  // what was given out — for long-term analytics the ephemeral Redis counters
  // can't answer. Non-critical, so it rides waitUntil and never blocks the claim.
  waitUntil(
    recordClaimEvent({
      service,
      plan: account.plan ?? session.plan ?? null,
      country: account.countryCode ?? session.country ?? null,
      accountId: account.id,
    }),
  )

  // freshLinks: the winning account is handed over with a freshly minted, direct
  // (no-proxy) nftoken so the direct login link is a valid session on first use.
  return { ok: true, account: await toGrantedAccount(account, service, { freshLinks: true }) }
}
