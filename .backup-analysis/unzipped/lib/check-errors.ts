// Structured error categories shared by the API route and the client. Replaces
// loose free-text error strings so failures can be counted, retried, and shown
// to the user with the right treatment.
export type CheckErrorCategory =
  | "rate_limited" // upstream (or our own) 429 — should back off and retry
  | "upstream_unavailable" // 5xx / connection error — transient, retryable
  | "timeout" // aborted by our UPSTREAM_TIMEOUT_MS — retryable
  | "upstream_error" // other non-OK upstream status — not retryable
  | "parse_error" // upstream returned something unparseable — not retryable
  | "invalid_input" // bad/empty cookie — not retryable
  | "unknown"

// Categories that are worth retrying with backoff.
export const RETRYABLE_CATEGORIES: ReadonlySet<CheckErrorCategory> = new Set([
  "rate_limited",
  "upstream_unavailable",
  "timeout",
])

export function isRetryable(category?: CheckErrorCategory): boolean {
  return category ? RETRYABLE_CATEGORIES.has(category) : false
}

// Categories the BULK runner should NOT bother retrying — they are properties of
// the cookie/input itself, so a fresh proxy or a later pass can never change them.
// Everything else (including upstream_error/403, parse_error and unknown, which in
// bulk are almost always a blocked or misbehaving proxy IP) is retried so a
// finished run leaves no transient errors behind.
const BULK_FATAL_CATEGORIES: ReadonlySet<CheckErrorCategory> = new Set(["invalid_input"])

// Whether the bulk runner should keep retrying a result with this error category.
// More aggressive than isRetryable on purpose: in bulk, a fresh proxy fixes most
// "errors", so we retry all but the genuinely fatal (bad-cookie) categories.
export function bulkShouldRetry(category?: CheckErrorCategory): boolean {
  if (!category) return false // not an error at all
  return !BULK_FATAL_CATEGORIES.has(category)
}

// Human-readable label for UI/tooltips.
export function errorLabel(category?: CheckErrorCategory): string {
  switch (category) {
    case "rate_limited":
      return "Rate limited"
    case "upstream_unavailable":
      return "Service unavailable"
    case "timeout":
      return "Timed out"
    case "upstream_error":
      return "Upstream error"
    case "parse_error":
      return "Unreadable response"
    case "invalid_input":
      return "Invalid cookie"
    default:
      return "Error"
  }
}
