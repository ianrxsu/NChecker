import { neon } from "@neondatabase/serverless"
import { bumpNeon } from "./usage-monitor"

// Single Neon serverless SQL client for the app's own tables (saved cookies).
// This app's admin area is gated by the existing HMAC admin session
// (lib/admin-auth.ts), so it does not use Better Auth — a lightweight HTTP SQL
// client is the right fit for the one table we own.
//
// `dbEnabled` lets callers degrade gracefully (and the admin UI surface a
// helpful message) when DATABASE_URL is not configured.
const connectionString = process.env.DATABASE_URL

export const dbEnabled = Boolean(connectionString)

const rawSql = connectionString ? neon(connectionString) : null

// Wrap the client in a Proxy that tallies each query for the in-process usage
// monitor (admin "Free-tier usage" card). The `apply` trap fires on every
// `sql\`...\`` tagged-template call while transparently forwarding to Neon and
// preserving all helper methods/types — so no call site changes and zero added
// network cost. If the counter ever throws it must not break a query.
export const sql = rawSql
  ? (new Proxy(rawSql, {
      apply(target, thisArg, args: unknown[]) {
        try {
          bumpNeon()
        } catch {
          /* observability only — never break a query */
        }
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args)
      },
    }) as typeof rawSql)
  : null
