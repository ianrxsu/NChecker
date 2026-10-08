import "server-only"
import { headers } from "next/headers"
import { getGatewayProvider } from "@/lib/gateway-provider"
import { buildShrinkEarnReturnUrl, shortenWithShrinkEarn, isShrinkEarnOnCooldown } from "@/lib/shrinkearn"
import { buildOiiReturnUrl, shortenWithOii, oiiConfigured } from "@/lib/oii"
import { buildShortXLinksReturnUrl, shortenWithShortXLinks } from "@/lib/shortxlinks"
import { getWebsiteShortXApiToken } from "@/lib/shortx-routing"

// The LootLabs gateway link. The `?Svh4w7ds` part is the link's SLUG (a valueless
// query key), not a normal parameter — it must be sent through completely
// untouched. We MUST NOT re-serialize it (e.g. via URLSearchParams), which would
// rewrite the slug to `Svh4w7ds=&...` and make LootLabs fail to resolve the link
// (blank page). We only ever append additional params by raw string concat AFTER
// the slug, preserving it verbatim.
const LOOTLABS_BASE = "https://loot-link.com/s?Svh4w7ds"

// Resolves the request origin from the proxy headers Vercel sets, used to build the
// signed ShrinkEarn/oii return URLs that point back at our own domain.
async function resolveOrigin(): Promise<string | null> {
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host")
  const proto = h.get("x-forwarded-proto") ?? "https"
  if (host) return `${proto}://${host}`
  const deploymentHost = process.env.VERCEL_URL || process.env.VERCEL_BRANCH_URL
  return deploymentHost ? `https://${deploymentHost}` : null
}

// Builds the gateway URL a given reward token must pass through, applying the admin's
// configured provider chain. Shared by BOTH the account generator start action and the
// dedicated /unlock (Access Pass) start action, so the delicate LootLabs slug handling
// and every provider fallback live in exactly one place.
//
// Every branch fails SAFE: if the chosen provider can't build a link (misconfigured /
// API error / IP on cooldown), we fall back to the LootLabs default so the user always
// passes a paying, unbypassable gate. On genuine completion the gateway flips the
// token's `unlocked` flag and returns the user to /reward-callback.
export async function buildGatewayUrl(token: string, ip: string, shortXApiToken?: string, forceShortX = false): Promise<string> {
  // LootLabs destination: attach the token as `puid` so it's echoed back to our
  // server-side postback as `click_id`. Appended by raw concat to keep the slug intact.
  const lootlabsUrl = `${LOOTLABS_BASE}&puid=${encodeURIComponent(token)}`
  let gatewayUrl = lootlabsUrl

  // The NF unlock path is explicitly ShortXLinks-only. Avoid loading the
  // provider settings/database for this path so a provider lookup failure cannot
  // crash the server action before the configured API is called.
  const provider = forceShortX ? "shortxlinks" : await getGatewayProvider()
  const origin = await resolveOrigin()

  async function tryShrinkEarn(): Promise<string | null> {
    if (!origin) return null
    const returnUrl = buildShrinkEarnReturnUrl(origin, token)
    const shortened = await shortenWithShrinkEarn(returnUrl)
    return shortened.ok ? shortened.url : null
  }

  async function tryOii(): Promise<string | null> {
    if (!origin || !oiiConfigured()) return null
    const returnUrl = buildOiiReturnUrl(origin, token)
    const shortened = await shortenWithOii(returnUrl)
    return shortened.ok ? shortened.url : null
  }

  async function tryShortXLinks(): Promise<string | null> {
    if (!origin) return null
    const returnUrl = buildShortXLinksReturnUrl(origin, token)
    const shortened = await shortenWithShortXLinks(returnUrl, shortXApiToken ?? (await getWebsiteShortXApiToken()))
    return shortened.ok ? shortened.url : null
  }

  if (forceShortX) {
    const shortXLinksUrl = await tryShortXLinks()
    if (shortXLinksUrl) gatewayUrl = shortXLinksUrl
  } else if (provider === "shortxlinks") {
    const shortXLinksUrl = await tryShortXLinks()
    if (shortXLinksUrl) gatewayUrl = shortXLinksUrl
  } else if (provider === "oii" || provider === "oii_only") {
    const oiiUrl = await tryOii()
    if (oiiUrl) gatewayUrl = oiiUrl
  } else if (provider === "shrinkearn_only") {
    // "Only" mode has NO paying fallback, so we do NOT consult the 24h cooldown here.
    // The cooldown only exists to decide WHEN to switch to another paying gate; with
    // no such gate, skipping ShrinkEarn would silently drop the user onto the LootLabs
    // default — the exact bug where selecting "ShrinkEarn only" still redirected to
    // LootLabs once the admin's own IP was on cooldown. A repeat (unpaid) ShrinkEarn
    // view is still a valid gate and honors the admin's explicit choice. LootLabs stays
    // only as a hard-failure safety net (ShrinkEarn API/ config genuinely unavailable).
    const shrinkUrl = await tryShrinkEarn()
    if (shrinkUrl) gatewayUrl = shrinkUrl
  } else if (provider === "shrinkearn" || provider === "shrinkearn_then_lootlabs") {
    if (!(await isShrinkEarnOnCooldown(ip))) {
      const shrinkUrl = await tryShrinkEarn()
      if (shrinkUrl) gatewayUrl = shrinkUrl
    }
  } else if (provider === "shrinkearn_then_oii") {
    if (!(await isShrinkEarnOnCooldown(ip))) {
      const shrinkUrl = await tryShrinkEarn()
      if (shrinkUrl) gatewayUrl = shrinkUrl
      else {
        const oiiUrl = await tryOii()
        if (oiiUrl) gatewayUrl = oiiUrl
      }
    } else {
      const oiiUrl = await tryOii()
      if (oiiUrl) gatewayUrl = oiiUrl
    }
  }
  // provider === "lootlabs" → gatewayUrl stays as the LootLabs default.

  return gatewayUrl
}
