import { randomUUID } from "node:crypto"
import { sql } from "@/lib/db"
import type { GeneratorService as Service } from "@/lib/check-via-proxies"

// Normalizes the stored `service` column into the Service union. Legacy rows
// (created before Prime/Crunchyroll existed) have NULL/“netflix” and default to netflix.
function asService(value: unknown): Service {
  return value === "prime" ? "prime" : value === "crunchyroll" ? "crunchyroll" : "netflix"
}

// Single-use reward gateway sessions. A token is minted (status='pending',
// unlocked=false) when the user starts the LootLabs flow. The session can ONLY be
// consumed after LootLabs confirms a genuine offer completion via its server-to-
// server postback (which flips unlocked=true). The atomic
//   UPDATE ... WHERE status='pending' AND unlocked=true
// is what makes the reward both unbypassable and single-use: a user who skips the
// gateway and navigates straight to /reward-callback finds unlocked=false and gets
// nothing, and only the first caller after unlock flips the row to 'used'.

export type RewardSession = {
  token: string
  plan: string | null
  country: string | null
  service: Service
}

// The server-verified state of a token, used by the callback to decide whether to
// distribute, wait for the postback, re-show an existing grant, or reject.
// A session's intent. "account" (default) → completing the gateway distributes an
// account. "pass" → completing the gateway grants a 24h device access pass and hands
// out NO account (used by the dedicated /unlock page in Access Pass mode).
export type SessionPurpose = "account" | "pass"

function asPurpose(value: unknown): SessionPurpose {
  return value === "pass" ? "pass" : "account"
}

export type RewardSessionState =
  | { state: "missing" } // no such token (never minted / wrong value)
  | { state: "locked"; service: Service; purpose: SessionPurpose } // minted + pending, gateway not confirmed yet
  | { state: "ready"; plan: string | null; country: string | null; service: Service; purpose: SessionPurpose } // unlocked, not consumed
  | { state: "used"; grantedId: string | null; service: Service; purpose: SessionPurpose } // already consumed (refresh case)

// Reads the current state of a token WITHOUT mutating it. Lets the callback
// distinguish "still waiting for the postback" (retry) from "invalid" (reject).
export async function getRewardSessionState(token: string): Promise<RewardSessionState> {
  if (!sql || !token) return { state: "missing" }
  const rows = (await sql`
    SELECT status, unlocked, plan, country, granted_id, service, purpose
    FROM reward_sessions
    WHERE token = ${token}
  `) as {
    status: string
    unlocked: boolean
    plan: string | null
    country: string | null
    granted_id: number | null
    service: string | null
    purpose: string | null
  }[]
  const row = rows[0]
  if (!row) return { state: "missing" }
  const service = asService(row.service)
  const purpose = asPurpose(row.purpose)
  if (row.status === "used") {
    return { state: "used", grantedId: row.granted_id == null ? null : String(row.granted_id), service, purpose }
  }
  if (!row.unlocked) return { state: "locked", service, purpose }
  return { state: "ready", plan: row.plan, country: row.country, service, purpose }
}

// Mints a new pending token bound to the user's plan/country selection AND the
// streaming service the request targets, so the callback distributes from the
// correct pool (Netflix vs Prime).
//
// `opts.unlocked` mints the row ALREADY unlocked (unlocked=true, unlocked_at=now()),
// used ONLY by Access Pass mode after a server-side valid-pass check — it lets the
// start action skip the gateway while reusing the exact same consume/distribute
// pipeline. The consume guard (`status='pending' AND unlocked=true`) is unchanged, so
// a row is still single-use and only ever pre-unlocked when a valid pass exists.
export async function createRewardSession(
  plan: string | null,
  country: string | null,
  service: Service = "netflix",
  opts?: { unlocked?: boolean; purpose?: SessionPurpose },
): Promise<string> {
  const token = randomUUID()
  if (!sql) return token // DB-less dev fallback; callback will reject as invalid.
  const purpose = opts?.purpose ?? "account"
  if (opts?.unlocked) {
    await sql`
      INSERT INTO reward_sessions (token, plan, country, status, service, unlocked, unlocked_at, purpose)
      VALUES (${token}, ${plan}, ${country}, 'pending', ${service}, true, now(), ${purpose})
    `
  } else {
    await sql`
      INSERT INTO reward_sessions (token, plan, country, status, service, purpose)
      VALUES (${token}, ${plan}, ${country}, 'pending', ${service}, ${purpose})
    `
  }
  return token
}

// Atomically consumes a pending token that has ALREADY been unlocked by the
// LootLabs postback. Returns the bound plan/country on the FIRST successful
// consume; null if the token is missing, not yet unlocked, already used, or the DB
// is unavailable. The `status='pending' AND unlocked=true` guard is the security
// boundary — it guarantees both single-use AND that the gateway was genuinely
// completed (a skipped gateway leaves unlocked=false, so nothing is handed out).
export async function consumeRewardSession(token: string): Promise<RewardSession | null> {
  if (!sql || !token) return null
  const rows = (await sql`
    UPDATE reward_sessions
    SET status = 'used', used_at = now()
    WHERE token = ${token} AND status = 'pending' AND unlocked = true AND purpose = 'account'
    RETURNING token, plan, country, service
  `) as { token: string; plan: string | null; country: string | null; service: string | null }[]
  if (rows.length === 0) return null
  return { token: rows[0].token, plan: rows[0].plan, country: rows[0].country, service: asService(rows[0].service) }
}

// Atomically consumes an unlocked, pending PASS session (purpose='pass'). Used by
// the /unlock flow: a genuine gateway completion flips unlocked=true, then this
// single-use guard flips it to 'used' so the 24h device pass is granted exactly once
// per completion. Returns the token on first consume; null if missing/not unlocked/
// already used. Never touches account sessions (purpose guard).
export async function consumePassSession(token: string): Promise<{ token: string; service: Service } | null> {
  if (!sql || !token) return null
  const rows = (await sql`
    UPDATE reward_sessions
    SET status = 'used', used_at = now()
    WHERE token = ${token} AND status = 'pending' AND unlocked = true AND purpose = 'pass'
    RETURNING token, service
  `) as { token: string; service: string | null }[]
  if (rows.length === 0) return null
  return { token: rows[0].token, service: asService(rows[0].service) }
}

// IP-keyed fallback consume for PASS sessions, mirroring consumeUnlockedSessionByIp
// but scoped to purpose='pass'. Recovers a genuine unlock when the reward-token
// cookie didn't survive the gateway round trip. Safe: the row could only have been
// unlocked by a secret-verified gateway completion.
export async function consumeUnlockedPassSessionByIp(
  ip: string,
  withinMinutes = 60,
): Promise<{ token: string; service: Service } | null> {
  if (!sql || !ip) return null
  const rows = (await sql`
    UPDATE reward_sessions
    SET status = 'used', used_at = now()
    WHERE token = (
      SELECT token FROM reward_sessions
      WHERE status = 'pending'
        AND unlocked = true
        AND purpose = 'pass'
        AND postback_ip = ${ip}
        AND unlocked_at > now() - make_interval(mins => ${withinMinutes})
      ORDER BY unlocked_at DESC
      LIMIT 1
    )
    RETURNING token, service
  `) as { token: string; service: string | null }[]
  if (rows.length === 0) return null
  return { token: rows[0].token, service: asService(rows[0].service) }
}

// FALLBACK consume keyed on the completing IP. LootLabs' {IP} macro records the
// END-USER's IP in the postback, so when a user returns to /reward-callback but
// the reward-token cookie didn't survive the gateway round trip (in-app browsers,
// new-tab opens, stripped cookies), we can still recover THEIR unlocked session by
// matching the request IP against a recently-unlocked, not-yet-consumed row. This
// is safe: the row could ONLY have been unlocked by a secret-verified postback, so
// matching IP + a short freshness window can't be forged into a free account.
// Atomic (single-use): picks the most recently unlocked pending row for the IP.
export async function consumeUnlockedSessionByIp(
  ip: string,
  withinMinutes = 60,
  service?: Service,
): Promise<RewardSession | null> {
  if (!sql || !ip) return null
  // When a service is supplied, only recover a session from THAT pool — the IP
  // fallback must never cross Netflix/Prime/Crunchyroll boundaries. `service IS
  // NULL` legacy rows count as netflix (matching asService()).
  const rows = (await sql`
    UPDATE reward_sessions
    SET status = 'used', used_at = now()
    WHERE token = (
      SELECT token FROM reward_sessions
      WHERE status = 'pending'
        AND unlocked = true
        AND purpose = 'account'
        AND postback_ip = ${ip}
        AND unlocked_at > now() - make_interval(mins => ${withinMinutes})
        AND (
          ${service ?? null}::text IS NULL
          OR COALESCE(service, 'netflix') = ${service ?? null}
        )
      ORDER BY unlocked_at DESC
      LIMIT 1
    )
    RETURNING token, plan, country, service
  `) as { token: string; plan: string | null; country: string | null; service: string | null }[]
  if (rows.length === 0) return null
  return { token: rows[0].token, plan: rows[0].plan, country: rows[0].country, service: asService(rows[0].service) }
}

// Re-display fallback keyed on IP: finds the most recent ALREADY-consumed session
// for this IP that produced a grant, so a refresh from the same device re-shows the
// same account even when the cookie is gone. Read-only.
export async function findGrantedSessionByIp(
  ip: string,
  withinMinutes = 60,
  service?: Service,
): Promise<{ token: string; grantedId: string; service: Service } | null> {
  if (!sql || !ip) return null
  const rows = (await sql`
    SELECT token, granted_id, service
    FROM reward_sessions
    WHERE status = 'used'
      AND purpose = 'account'
      AND granted_id IS NOT NULL
      AND postback_ip = ${ip}
      AND used_at > now() - make_interval(mins => ${withinMinutes})
      AND (
        ${service ?? null}::text IS NULL
        OR COALESCE(service, 'netflix') = ${service ?? null}
      )
    ORDER BY used_at DESC
    LIMIT 1
  `) as { token: string; granted_id: number | null; service: string | null }[]
  const row = rows[0]
  if (!row || row.granted_id == null) return null
  return { token: row.token, grantedId: String(row.granted_id), service: asService(row.service) }
}

// Called ONLY from the LootLabs postback endpoint (after the shared secret has
// been verified) to mark a token as genuinely unlocked. Idempotent: re-delivered
// postbacks for the same token are harmless. `lootlabs_unique_id` is stored under
// a partial UNIQUE index so a duplicate completion id can never unlock a second
// token. Returns true if a pending row was unlocked (or was already unlocked).
export async function markRewardUnlocked(
  token: string,
  uniqueId: string | null,
  ip: string | null,
): Promise<boolean> {
  if (!sql || !token) return false
  try {
    const rows = (await sql`
      UPDATE reward_sessions
      SET unlocked = true,
          unlocked_at = COALESCE(unlocked_at, now()),
          lootlabs_unique_id = COALESCE(lootlabs_unique_id, ${uniqueId}),
          postback_ip = COALESCE(postback_ip, ${ip})
      WHERE token = ${token} AND status = 'pending'
      RETURNING token
    `) as { token: string }[]
    return rows.length > 0
  } catch (err) {
    // A unique-violation on lootlabs_unique_id means this completion id was already
    // used to unlock another token — reject silently to prevent replay.
    console.log("[v0] markRewardUnlocked rejected:", err)
    return false
  }
}

// Records which saved-cookie id was granted for a consumed token (so the grant
// can be re-displayed on refresh without consuming or distributing again).
export async function setRewardGrant(token: string, grantedId: string): Promise<void> {
  if (!sql) return
  const numeric = Number(grantedId)
  if (!Number.isInteger(numeric)) return
  await sql`UPDATE reward_sessions SET granted_id = ${numeric} WHERE token = ${token}`
}

// Looks up the granted saved-cookie id for an already-consumed token.
export async function getRewardGrant(token: string): Promise<string | null> {
  if (!sql || !token) return null
  const rows = (await sql`
    SELECT granted_id FROM reward_sessions WHERE token = ${token} AND status = 'used'
  `) as { granted_id: number | null }[]
  const id = rows[0]?.granted_id
  return id == null ? null : String(id)
}
