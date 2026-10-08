import { redis, redisEnabled } from "./redis"
import { getCachedConfig, bustConfigCache } from "./config-cache"

// Admin-controlled visibility for the PUBLIC checkers (/netflix, /prime,
// /crunchyroll). Lets an admin hide every public checker at once, hide one
// service's checker entirely, or hide just the bulk mode for a service — all
// without a redeploy. Lives in Redis so it takes effect instantly across every
// serverless/edge instance, exactly like the maintenance kill switch.
//
// This ONLY affects the public site. The admin panel's own embedded checkers are
// never gated by this — an admin must always be able to check cookies.

const KEY = "site:checker-visibility"

// The public checker pages are force-dynamic and read this on EVERY page view, so
// we front the Redis read with a short in-process cache (see lib/config-cache).
// Admin changes propagate to all warm instances within CACHE_TTL_MS; the writer
// busts its own cache immediately.
const CACHE_KEY = "checker-visibility"
const CACHE_TTL_MS = 30_000

// The three public checkers. (Steam/Spotify exist only inside the admin panel and
// have no public route, so they are intentionally not part of this config.)
export const PUBLIC_CHECKER_SERVICES = ["netflix", "prime", "crunchyroll"] as const
export type CheckerService = (typeof PUBLIC_CHECKER_SERVICES)[number]

export type ServiceVisibility = {
  // Hide this service's checker entirely (both single + bulk) from the public.
  hidden: boolean
  // Hide ONLY the bulk checker for this service; the single checker stays public.
  bulkHidden: boolean
}

export type CheckerVisibility = {
  // Master switch — hide ALL public checkers regardless of per-service settings.
  allHidden: boolean
  // Opt-in: expose the unified "smart" all-in-one checker at /checker. Defaults
  // OFF so the new feature only appears once an admin turns it on. Independent of
  // the per-service hide flags below (which still gate the classic /netflix,
  // /prime, /crunchyroll pages).
  smartCheckerEnabled: boolean
  // When true, checker results on the PUBLIC site show Direct Auth Links ONLY —
  // all cookie copy actions (Copy cookies, raw, Netscape, manual show) are hidden.
  // The admin panel's own checkers are never affected.
  linksOnly: boolean
  // When true, the Netflix ACCOUNT GENERATOR (checker + rechecker results inside
  // the generator, not the public /netflix checker) shows Direct Auth Links ONLY —
  // cookie copy actions are hidden. Prime/Crunchyroll generators are never affected.
  netflixGeneratorLinksOnly: boolean
  // Hide the public browser-extension landing page and download CTA.
  extensionHidden: boolean
  // When false, public checkers must use visitor-supplied manual proxies.
  autoProxyScrapeEnabled: boolean
  services: Record<CheckerService, ServiceVisibility>
  // Per-service hide for the PUBLIC account generators (/account-generator,
  // /prime/account-generator, /crunchyroll/account-generator). `true` = that
  // generator is hidden from the public (page shows an "unavailable" notice and its
  // links are dropped from the home page + footer). Independent of the checker
  // hides above — hiding the Netflix generator never touches the Netflix checker.
  generators: Record<CheckerService, boolean>
}

function defaultServiceVisibility(): ServiceVisibility {
  return { hidden: false, bulkHidden: false }
}

// Everything visible — the fail-open default whenever Redis is down or unset.
export function defaultVisibility(): CheckerVisibility {
  return {
    allHidden: false,
    smartCheckerEnabled: false,
    linksOnly: false,
    netflixGeneratorLinksOnly: false,
    extensionHidden: false,
    autoProxyScrapeEnabled: true,
    services: {
      netflix: defaultServiceVisibility(),
      prime: defaultServiceVisibility(),
      crunchyroll: defaultServiceVisibility(),
    },
    generators: {
      netflix: false,
      prime: false,
      crunchyroll: false,
    },
  }
}

// Coerces whatever is stored (possibly partial/old) into a complete, safe shape.
function normalize(raw: unknown): CheckerVisibility {
  const base = defaultVisibility()
  if (!raw || typeof raw !== "object") return base
  const r = raw as Record<string, unknown>
  base.allHidden = Boolean(r.allHidden)
  base.smartCheckerEnabled = Boolean(r.smartCheckerEnabled)
  base.linksOnly = Boolean(r.linksOnly)
  base.netflixGeneratorLinksOnly = Boolean(r.netflixGeneratorLinksOnly)
  base.extensionHidden = Boolean(r.extensionHidden)
  base.autoProxyScrapeEnabled = r.autoProxyScrapeEnabled === undefined ? true : Boolean(r.autoProxyScrapeEnabled)
  const services = (r.services as Record<string, unknown> | undefined) ?? {}
  const generators = (r.generators as Record<string, unknown> | undefined) ?? {}
  for (const svc of PUBLIC_CHECKER_SERVICES) {
    const s = (services[svc] as Record<string, unknown> | undefined) ?? {}
    base.services[svc] = {
      hidden: Boolean(s.hidden),
      bulkHidden: Boolean(s.bulkHidden),
    }
    base.generators[svc] = Boolean(generators[svc])
  }
  return base
}

// Reads the current visibility config. Fails OPEN (everything visible) whenever
// Redis is unavailable — a flaky DB must never hide the whole product.
export async function getCheckerVisibility(): Promise<CheckerVisibility> {
  if (!redisEnabled) return defaultVisibility()
  return getCachedConfig(CACHE_KEY, CACHE_TTL_MS, async () => {
    try {
      const raw = await redis.get<CheckerVisibility>(KEY)
      return normalize(raw)
    } catch {
      return defaultVisibility()
    }
  })
}

// Persists a new config (already normalized by the caller/route).
//
// Unlike the READ path (which fails open so a flaky DB can't hide the whole site),
// the WRITE path must NOT swallow failures: if the admin's change didn't actually
// persist, they need to know — otherwise the UI shows "saved" while the public site
// never changes. Throws when Redis is unavailable or the write fails.
export async function setCheckerVisibility(next: CheckerVisibility): Promise<CheckerVisibility> {
  const clean = normalize(next)
  if (!redisEnabled) {
    throw new Error("Storage is not configured, so visibility changes can't be saved.")
  }
  await redis.set(KEY, clean)
  // Reflect the change immediately on this instance; others converge within the TTL.
  bustConfigCache(CACHE_KEY)
  return clean
}

// ── Pure helpers (no I/O) so pages/components share one source of truth ──────

// Is the service's checker shown publicly at all? (master OR per-service hide)
export function isCheckerVisible(vis: CheckerVisibility, service: CheckerService): boolean {
  return !vis.allHidden && !vis.services[service].hidden
}

// Is the single checker shown? Same as the checker being visible at all.
export function isSingleVisible(vis: CheckerVisibility, service: CheckerService): boolean {
  return isCheckerVisible(vis, service)
}

// Is this service's PUBLIC account generator shown? Independent of the checker
// hides — driven solely by the per-generator switch the admin controls.
export function isGeneratorVisible(vis: CheckerVisibility, service: CheckerService): boolean {
  return !vis.generators[service]
}

// Is the bulk checker shown? Only when the checker is visible AND bulk isn't hidden.
export function isBulkVisible(vis: CheckerVisibility, service: CheckerService): boolean {
  return isCheckerVisible(vis, service) && !vis.services[service].bulkHidden
}

// Is the unified smart checker (/checker) publicly reachable? Gated by its own
// opt-in switch AND the master hide (turning off everything also hides it).
export function isSmartCheckerVisible(vis: CheckerVisibility): boolean {
  return !vis.allHidden && vis.smartCheckerEnabled
}

// Which services can the smart checker offer publicly right now? A service is only
// selectable if its classic checker isn't hidden — so the admin's per-service hide
// flags are respected inside the unified checker too.
export function smartCheckerServices(vis: CheckerVisibility): CheckerService[] {
  return PUBLIC_CHECKER_SERVICES.filter((svc) => isCheckerVisible(vis, svc))
}

// Within the smart checker, is bulk mode allowed for a given service? Mirrors the
// classic per-service bulk gate.
export function smartBulkAllowed(vis: CheckerVisibility, service: CheckerService): boolean {
  return isBulkVisible(vis, service)
}
