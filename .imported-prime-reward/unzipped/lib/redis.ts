import { Redis } from "@upstash/redis"
import { bumpRedis } from "./usage-monitor"

// Shared Upstash Redis client. Backed by the integration's REST env vars so it
// works across every serverless instance (counters/metrics are not per-instance).
const rawRedis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

// Wrap the client so every command is tallied for the in-process usage monitor
// (admin "Free-tier usage" card). The `get` trap only intercepts method calls —
// it bumps the counter then forwards to the real command — so it adds zero
// network cost and preserves behavior. Counting the top-level command is a close
// proxy for Upstash's per-command billing unit (pipelined sub-commands are not
// separately counted, which is a minor, safe under-count).
export const redis = new Proxy(rawRedis, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (typeof value === "function") {
      return (...args: unknown[]) => {
        try {
          bumpRedis()
        } catch {
          /* observability only — never break a command */
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
    return value
  },
})

// True only when the integration env vars are present. Lets callers degrade
// gracefully (e.g. skip rate limiting / metrics) in local/demo setups.
export const redisEnabled = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
