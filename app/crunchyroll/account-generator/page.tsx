import type { Metadata } from "next"
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
import { requireGeneratorLogin, getClaimAccountId } from "@/lib/generator-auth"
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
  await requireGeneratorLogin("/crunchyroll/account-generator")
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
  const accountClaimId = await getClaimAccountId()
  const allowance = await claimAllowance(
    "crunchyroll",
    ip,
    deviceId,
    fingerprint,
    codeLimits ? { ...codeLimits, scope: "lifetime", accessCodeId: pass.accessCodeId } : undefined,
    accountClaimId,
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
        <div className="mb-10 flex flex-col gap-4 anim-condense">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            Free · Verified · Limited
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl">
            Claim a free{" "}
            <span className="inline-block border border-border bg-primary px-2 text-primary-foreground shadow-lg">
              Crunchyroll
            </span>{" "}
            account
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Stock is limited, so there&apos;s no plan or country to pick — complete one quick step and you&apos;ll get a{" "}
            <span className="font-semibold text-accent">random premium account</span>. Every Crunchyroll account is{" "}
            <span className="font-semibold text-accent">checked live</span> the moment you claim it, so you only ever
            get one that actually works.
          </p>
        </div>

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
        />

        <ClaimedAccounts initial={claimed} service="crunchyroll" />
      </div>

      <div className="mt-auto">
        <SiteFooter visibility={visibility} />
      </div>
    </main>
  )
}
