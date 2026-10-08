import { translateAccountResult } from "@/lib/translate-details"
import { mintNetflixLinksDirect } from "@/lib/check-via-proxies"
import { prepareCookieForCheck } from "@/lib/cookie-utils"
import type { CheckResult } from "@/lib/normalize-upstream"
import type { SavedCookie } from "@/lib/saved-cookies"
import type { Service } from "@/lib/check-via-proxies"

// Mints a FRESH Netflix auto-login token exactly like the WORKING single checker: a
// DIRECT mint from our own server IP, with NO proxy and NO caching. The
// reward/claim/recheck paths used to fall back to minting through the rotating
// free-proxy pool, and Netflix REJECTS a token minted from a flagged/rotating exit
// at redemption — that was the "link opens but isn't a valid session" bug on the
// reward-callback + distributed/claimed accounts. Direct-only minting mirrors the
// single checker, whose links reliably log in. The critical first step is
// normalizing the stored cookie into a header string via prepareCookieForCheck — the
// minter reads `NetflixId` from a header-format cookie, so a raw stored (JSON) cookie
// yields no token. Best-effort: returns undefined on any failure, so the account
// still renders fully without links.
async function mintNetflixLinks(storedCookie: string, freshLinks = false): Promise<CheckResult["links"]> {
  // Re-parse ANY stored format (cookie-editor JSON, Netscape, header) down to the
  // header string the minter expects — this is what the single checker feeds it.
  const headerCookie = prepareCookieForCheck(storedCookie, "netflix").cookie || storedCookie
  try {
    // freshLinks bypasses the short mint cache so hand-outs/rechecks always get a
    // brand-new nftoken; passive list renders reuse the cached token briefly.
    const direct = await mintNetflixLinksDirect(headerCookie, freshLinks)
    if (hasLinks(direct)) return direct

    // Do not use a proxy fallback. The caller can continue to another account
    // when this account cannot produce a direct link from the server IP.
  } catch {
    return undefined
  }
}

// The full account payload handed to the UI: the cookie plus a complete,
// English-normalized CheckResult so any screen can render every detail (plan,
// country, email, payment, billing, profiles, direct links) exactly like the
// single checker. Shared by the claim screen and the "your accounts" list.
export type GrantedAccount = {
  id: string
  cookie: string
  result: CheckResult
}

function hasLinks(links: CheckResult["links"]): boolean {
  return Boolean(links && (links.pc || links.mobile || links.tv))
}

// Builds a UI-ready GrantedAccount from a saved row, translating any localized
// detail fields (dates, payment method) into consistent English. Saved rows are
// stored WITHOUT direct links, so when none are present we mint the Netflix
// auto-login (PC/Mobile/TV) links from the cookie on the fly — giving distributed
// and claimed accounts the same "Direct Auth Links" section as the single checker.
// Minting is best-effort: a dead cookie simply yields no links.
export async function toGrantedAccount(
  c: SavedCookie,
  service: Service = "netflix",
  opts?: { freshLinks?: boolean },
): Promise<GrantedAccount> {
  const result: CheckResult = {
    valid: true,
    email: c.email ?? undefined,
    plan: c.plan ?? undefined,
    countryCode: c.countryCode ?? undefined,
    paymentMethod: c.paymentMethod ?? undefined,
    nextBillingCycle: c.nextBillingCycle ?? undefined,
    memberSince: c.memberSince ?? undefined,
    phone: c.phone ?? undefined,
    maxStreams: c.maxStreams ?? undefined,
    emailVerified: c.emailVerified ?? undefined,
    profiles: c.profiles ?? undefined,
    links: c.links ?? undefined,
  }

  // Auto-login link minting is a Netflix-only capability; Prime has no equivalent,
  // so we only mint for Netflix accounts. Uses the same DIRECT (no-proxy) minting
  // the working single checker uses, so distributed/claimed/rechecked accounts get
  // the same reliably-logging-in "Direct Auth Links" (PC/Mobile/TV) section. We
  // ALWAYS mint for Netflix (not just when links are absent) so every hand-out and
  // recheck surfaces a FRESH nftoken; the stored links only stand in if the mint
  // fails. `freshLinks` bypasses the short mint cache for explicit rechecks.
  if (service === "netflix") {
    const minted = await mintNetflixLinks(c.cookie, opts?.freshLinks === true)
    if (hasLinks(minted)) result.links = minted
  }

  return { id: c.id, cookie: c.cookie, result: translateAccountResult(result) }
}
