// Shared constants for the pending reward-token cookie. The token is stashed here
// before redirecting into the LootLabs gateway so it survives the round trip even
// when the gateway drops the query string, and is read back (and cleared) by the
// /reward-callback flow on return.
export const REWARD_TOKEN_COOKIE = "reward_token"

// 1 hour — long enough to complete the gateway, short enough that a stale token
// doesn't linger. The session row itself is the real single-use guard.
export const REWARD_TOKEN_MAX_AGE = 60 * 60

// The cookie holds a SHORT LIST of the most-recently minted tokens (newest first),
// not just one. Users frequently start the gateway more than once (e.g. tapping
// "Try Again", or starting a new run before an earlier completion's postback lands),
// which would otherwise leave the cookie pointing at a newer, not-yet-completed
// token while the genuinely-unlocked earlier token is stranded. Keeping a list lets
// /reward-callback try every recent token and consume whichever the postback has
// unlocked — independent of IP (which rotates on mobile networks). Capped so the
// cookie stays tiny and old tokens age out.
const MAX_TOKENS = 6

// Parse the cookie value into a token list. Tolerates the legacy single-token
// format (a bare UUID) so existing cookies keep working after this change.
export function parseRewardTokens(value: string | undefined | null): string[] {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) return arr.filter((t): t is string => typeof t === "string" && t.length > 0)
    } catch {
      // fall through to delimiter parsing
    }
  }
  // Legacy / fallback: single token or comma-separated list.
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
}

// Prepend a freshly-minted token, dedupe, and cap the list. Returns the serialized
// cookie value to store.
export function serializeRewardTokens(newToken: string, existing: string[]): string {
  const list = [newToken, ...existing.filter((t) => t !== newToken)].slice(0, MAX_TOKENS)
  return JSON.stringify(list)
}
