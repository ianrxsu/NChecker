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
import { isNetflixExtensionUsed } from "@/app/account-generator/limit-extension-actions"
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
  title: "Free Netflix Account — Cookies Mo",
  description:
    "Claim a free, working Netflix account. Pick the plan and country you want, complete one quick step, and your account is checked live and revealed instantly.",
}

// Always read the live pool so plan/country counts reflect the current database.
export const dynamic = "force-dynamic"

export default async function AccountGeneratorPage({ searchParams }: { searchParams: Promise<{ unlock?: string }> }) {
  const { unlock } = await searchParams
  const [ip, deviceId] = await Promise.all([requestIp(), readDeviceId()])
  const [options, claimed, visibility, passMode, pass] = await Promise.all([
    getPoolOptions(),
    listClaimedAccounts(),
    getCheckerVisibility(),
    isAccessPassMode(),
    getPass(deviceId),
  ])

  if (passMode && !pass.valid) redirect("/unlock?service=netflix")
  const accessPass = { mode: passMode, active: pass.valid, expiresAt: pass.expiresAt }
  const codeLimits = pass.accessCodeId ? await getAccessCodeLimits(pass.accessCodeId, "netflix") : null
  const fingerprint = await fingerprintFromNextHeaders(ip)
  const allowance = await claimAllowance(
    "netflix",
    ip,
    deviceId,
    fingerprint,
    codeLimits ? { ...codeLimits, scope: "lifetime" } : undefined,
  )
  const generatorLinksOnly = visibility.netflixGeneratorLinksOnly
  const extensionUsed = await isNetflixExtensionUsed(deviceId)

  // Admin hid this generator — show a friendly notice (takes priority over the
  // access-pass redirect below so a hidden page never bounces to /unlock).
  if (!isGeneratorVisible(visibility, "netflix")) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Free Netflix Account" noun="account generator" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  // If this visitor is already at the Netflix cap, hand the selection UI a block so
  // the countdown renders on load (button hidden) instead of only after an attempt.
  const initialBlock = allowance.allowed
    ? null
    : { resetMs: allowance.resetMs, label: allowance.label, limit: allowance.limit }

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" />

      {unlock === "success" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="unlock-success-title">
          <div className="w-full max-w-md border border-accent bg-card p-6 shadow-2xl">
            <h2 id="unlock-success-title" className="text-xl font-semibold uppercase tracking-tight text-foreground">Netflix limit extended</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Your current Netflix claim limit has been extended for this window. You can now continue claiming accounts.</p>
            <a href="/account-generator" className="mt-6 inline-flex w-full items-center justify-center border border-border bg-primary px-5 py-3 text-sm font-semibold uppercase tracking-widest text-primary-foreground">Continue</a>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Intro */}
        <PublicPageIntro title="Your next Netflix account." category="Account access" description="Choose from the available plans and countries, then follow the unlock steps. Accounts are checked when you claim them." guide="/unlock-guide" guideLabel="How claiming works" />

        {/* Compact guide link — hidden in Access Pass mode since there is no gateway step */}
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
          initialBlock={initialBlock}
          accessPass={accessPass}
          allowance={allowance}
          extensionUsed={extensionUsed}
        />

        <ClaimedAccounts initial={claimed} hideCookies={generatorLinksOnly} />
      </div>

      <div className="mt-auto">
        <SiteFooter visibility={visibility} />
      </div>
    </main>
  )
}
