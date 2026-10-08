import { redis, redisEnabled } from "./redis"
import { getCachedConfig, bustConfigCache } from "./config-cache"

// Admin-controlled choice of which monetization GATEWAY the account generator
// sends users through before a reward is unlocked. Switchable at runtime (no
// redeploy). Read through a short in-process cache so it doesn't hit Redis on
// every generator start.
//
// PROVIDERS
// ─────────
//   "lootlabs"
//       The original, truly unbypassable gateway. A reward only unlocks via a
//       server-to-server postback that LootLabs fires on genuine completion.
//
//   "shrinkearn"
//       URL-shortener gateway. No completion postback; hardened via a one-time
//       HMAC-signed return URL + minimum dwell time + single-use DB guard. Once
//       an IP earns a paid view, auto-routes through LootLabs for 24 h (ShrinkEarn
//       pays once per IP per day).
//
//   "oii" / "oii_only"
//       oii.io URL shortener (SAME API shape as ShrinkEarn — NOT a postback locker).
//       Hardened via a one-time HMAC-signed return URL + single-use DB guard, but
//       UNLIKE ShrinkEarn there is NO 24h per-IP cooldown, so it behaves "like
//       LootLabs": the same IP can pass repeatedly. Requires OII_API_TOKEN.
//
//   "shrinkearn_then_oii"
//       Primary: ShrinkEarn (URL shortener, 24h pay-per-IP). Fallback when that
//       IP's ShrinkEarn cooldown is active: oii.io (shortener, no cooldown) so
//       repeat visitors still hit a paying gate. Best monetization combo.
//
//   "shrinkearn_then_lootlabs"
//       Primary: ShrinkEarn. Fallback: LootLabs. The original chain mode.
//
//   "shrinkearn_only"
//       Always ShrinkEarn, no fallback — the 24h pay-per-IP cooldown is ignored
//       (an IP past its cap still passes through ShrinkEarn, just as an unpaid
//       view). LootLabs is used only if the ShrinkEarn API is genuinely unavailable.
//
//   "shortxlinks"
//       ShortXLinks URL shortener using the same signed-return and dwell-time
//       protection as ShrinkEarn. LootLabs remains the hard-failure fallback.

const KEY = "site:gateway-provider"
const CACHE_KEY = "gateway-provider"
const CACHE_TTL_MS = 30_000

export const GATEWAY_PROVIDERS = [
  "lootlabs",
  "shrinkearn",
  "oii",
  "shrinkearn_then_oii",
  "shrinkearn_then_lootlabs",
  "oii_only",
  "shrinkearn_only",
  "shortxlinks",
] as const
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number]

export const DEFAULT_GATEWAY_PROVIDER: GatewayProvider = "lootlabs"

export function isGatewayProvider(value: unknown): value is GatewayProvider {
  return GATEWAY_PROVIDERS.includes(value as GatewayProvider)
}

export async function getGatewayProvider(): Promise<GatewayProvider> {
  if (!redisEnabled) return DEFAULT_GATEWAY_PROVIDER
  return getCachedConfig(CACHE_KEY, CACHE_TTL_MS, async () => {
    try {
      const raw = await redis.get<string>(KEY)
      return isGatewayProvider(raw) ? raw : DEFAULT_GATEWAY_PROVIDER
    } catch {
      return DEFAULT_GATEWAY_PROVIDER
    }
  })
}

export async function setGatewayProvider(next: GatewayProvider): Promise<GatewayProvider> {
  const clean: GatewayProvider = isGatewayProvider(next) ? next : DEFAULT_GATEWAY_PROVIDER
  if (!redisEnabled) {
    throw new Error("Storage is not configured, so the gateway provider can't be saved.")
  }
  await redis.set(KEY, clean)
  bustConfigCache(CACHE_KEY)
  return clean
}
