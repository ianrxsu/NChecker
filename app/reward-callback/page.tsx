import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { AccountClaim } from "@/components/account-generator/account-claim"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { REWARD_TOKEN_COOKIE, parseRewardTokens } from "@/lib/reward-token-cookie"
import { getRewardSessionState } from "@/lib/reward-store"
import { getCheckerVisibility } from "@/lib/checker-visibility"

// Live verification through the proxy pool can take several seconds, so give the
// claim action room to finish. Always dynamic — every callback is unique.
export const maxDuration = 60
export const dynamic = "force-dynamic"

export const metadata = {
  title: "Unlocking your account · Cookies Mo",
}

export default async function RewardCallbackPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams
  // Collect every candidate token: the query param (if LootLabs forwarded it) PLUS
  // the recent-token list from the first-party cookie. The claim tries them all and
  // consumes whichever the postback has unlocked — robust against repeated starts
  // and mobile IP rotation, since LootLabs doesn't guarantee query passthrough.
  const fromQuery = typeof r === "string" ? r.trim() : ""
  const fromCookie = parseRewardTokens((await cookies()).get(REWARD_TOKEN_COOKIE)?.value)
  const tokens = [...(fromQuery ? [fromQuery] : []), ...fromCookie].filter((t, i, arr) => t && arr.indexOf(t) === i)

  // No token at all → bounce to the generator page with a helpful message.
  if (tokens.length === 0) redirect("/account-generator?error=missing")

  // Resolve which service these tokens belong to so the header branding and the
  // claim screen's "Try again / Claim another" links return to the right generator.
  // The first token with a known session wins; defaults to Netflix.
  let service: "netflix" | "prime" | "crunchyroll" = "netflix"
  for (const token of tokens) {
    const state = await getRewardSessionState(token)
    if (state.state !== "missing") {
      service = state.service
      break
    }
  }
  // Each service returns to its own generator for the "back" link; anything
  // unknown falls back to the Netflix generator.
  const backHref =
    service === "prime"
      ? "/prime/account-generator"
      : service === "crunchyroll"
        ? "/crunchyroll/account-generator"
        : "/account-generator"

  const resolvedPass = await (async () => {
    for (const token of tokens) {
      const state = await getRewardSessionState(token)
      if (state.state !== "missing" && state.purpose === "pass") return { token, state }
    }
    return null
  })()
  if (resolvedPass?.state.state === "ready" || resolvedPass?.state.state === "used") {
    redirect(`${backHref}?unlock=success`)
  }

  // Netflix generator links-only: hide cookie copy actions on the claim result for
  // Netflix only. Prime/Crunchyroll are unaffected regardless of this setting.
  const visibility = await getCheckerVisibility()
  const hideCookies = service === "netflix" && visibility.netflixGeneratorLinksOnly

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" service={service} />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Claim card stays centered and readable inside the wide main-page container. */}
        <div className="mx-auto w-full max-w-2xl">
          <AccountClaim tokens={tokens} backHref={backHref} service={service} hideCookies={hideCookies} />
        </div>
      </div>

      <div className="mt-auto">
        <SiteFooter />
      </div>
    </main>
  )
}
