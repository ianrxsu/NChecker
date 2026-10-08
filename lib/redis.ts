import { Redis } from "@upstash/redis"
import { bumpRedis } from "./usage-monitor"

// Upstash is optional for local development and must never prevent the site from loading.
export const redisEnabled = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

const rawRedis = redisEnabled
  ? new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
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
