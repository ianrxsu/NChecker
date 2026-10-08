import type { Metadata } from "next"
import { PublicPageIntro } from "@/components/public-page-intro"
import { getPoolOptions } from "@/lib/reward-distribution"
import { listClaimedAccounts } from "@/app/account-generator/claimed-actions"
import { claimAllowance } from "@/lib/rate-limit"
import { requestIp } from "@/lib/request-ip"
import { readDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import { isAccessPassMode, getPass } from "@/lib/access-pass"
import { getAccessCodeLimits } from "@/lib/access-codes"
import Link from "next/link"
import { redirect } from "next/navigation"
import { AccountSelection } from "@/components/account-generator/account-selection"
import { ClaimedAccounts } from "@/components/account-generator/claimed-accounts"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { TelegramBotPromo, TelegramPromo } from "@/components/telegram-promo"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { getCheckerVisibility, isGeneratorVisible } from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Free Crunchyroll Account — Cookies Mo",
  description:
    "Claim a free, working Crunchyroll premium account. Complete one quick step and a random account is checked live and revealed instantly. Limited stock.",
}

// Always read the live pool so the availability count reflects the current database.
export const dynamic = "force-dynamic"

export default async function CrunchyrollAccountGeneratorPage() {
  // Both reads are scoped to the Crunchyroll pool / Crunchyroll "already received" cookie.
  const [ip, deviceId] = await Promise.all([requestIp(), readDeviceId()])
  const [options, claimed, visibility, passMode, pass] = await Promise.all([
    getPoolOptions("crunchyroll"),
    listClaimedAccounts("crunchyroll"),
    getCheckerVisibility(),
    isAccessPassMode(),
    getPass(deviceId),
  ])

  if (passMode && !pass.valid) redirect("/unlock?service=crunchyroll")
  const accessPass = { mode: passMode, active: pass.valid, expiresAt: pass.expiresAt }
  const codeLimits = pass.accessCodeId ? await getAccessCodeLimits(pass.accessCodeId, "crunchyroll") : null
  const fingerprint = await fingerprintFromNextHeaders(ip)
  const allowance = await claimAllowance(
    "crunchyroll",
    ip,
    deviceId,
    fingerprint,
    codeLimits ? { ...codeLimits, scope: "lifetime" } : undefined,
  )

  // Admin hid this generator — show a friendly notice (before the access-pass
  // redirect so a hidden page never bounces to /unlock).
  if (!isGeneratorVisible(visibility, "crunchyroll")) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader service="crunchyroll" />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Free Crunchyroll Account" noun="account generator" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  // If this visitor is already at the Crunchyroll cap, show the countdown on load.
  const initialBlock = allowance.allowed
    ? null
    : { resetMs: allowance.resetMs, label: allowance.label, limit: allowance.limit }

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" service="crunchyroll" />

      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Intro */}
        <PublicPageIntro title="Your next Crunchyroll account." category="Account access" description="Explore premium accounts from the available stock. Selection is random, and each account is checked when you claim it." guide="/unlock-guide" guideLabel="How claiming works" />

        <div className="mb-8 flex flex-col gap-3 sm:flex-row">
          <TelegramPromo />
          <TelegramBotPromo />
        </div>

        <AccountSelection
          plans={options.plans}
          countries={options.countries}
          combos={options.combos}
          untagged={options.untagged}
          displayCombos={options.displayCombos}
          displayUntagged={options.displayUntagged}
          service="crunchyroll"
          showPlanSelection={false}
          showCountrySelection={false}
          initialBlock={initialBlock}
          accessPass={accessPass}
          allowance={allowance}
          guideLink="/cookies-guide"
        />

        <ClaimedAccounts initial={claimed} service="crunchyroll" />
      </div>

      <div className="mt-auto">
        <SiteFooter visibility={visibility} />
      </div>
    </main>
  )
}
