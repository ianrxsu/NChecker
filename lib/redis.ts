import { Redis } from "@upstash/redis"
import { bumpRedis } from "./usage-monitor"

// Prefer the newly connected Upstash integration credentials. Keep the legacy
// names as a fallback for environments that have not been migrated yet.
const redisUrl =
  process.env.UPSTASH_KV_KV_REST_API_URL ?? process.env.KV_REST_API_URL
const redisToken =
  process.env.UPSTASH_KV_KV_REST_API_TOKEN ?? process.env.KV_REST_API_TOKEN

// Upstash is optional for local development and must never prevent the site from loading.
export const redisEnabled = Boolean(redisUrl && redisToken)

const rawRedis = redisEnabled
  ? new Redis({
      url: redisUrl!,
      token: redisToken!,
      retry: { retries: 0 },
    })
  : null

// Keep the existing Redis API while counting commands locally for the admin usage card.
// When Upstash is unavailable, callers that already guard redisEnabled continue to fail open.
export const redis = (rawRedis
  ? new Proxy(rawRedis, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          try {
            bumpRedis()
          } catch {
            // Usage monitoring is best-effort and must never break Redis calls.
          }
          return (value as (...callArgs: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  : ({} as Redis)) as Redis
