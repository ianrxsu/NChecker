import type { Metadata } from "next"
import { getPoolOptions } from "@/lib/reward-distribution"
import { listClaimedAccounts } from "@/app/account-generator/claimed-actions"
import { claimAllowance } from "@/lib/rate-limit"
import { requestIp } from "@/lib/request-ip"
import { readDeviceId } from "@/lib/device-id"
import { isAccessPassMode, getPass } from "@/lib/access-pass"
import { getAccessCodeLimits } from "@/lib/access-codes"
import Link from "next/link"
import { redirect } from "next/navigation"
import { BookOpen } from "lucide-react"
import { AccountSelection } from "@/components/account-generator/account-selection"
import { ClaimedAccounts } from "@/components/account-generator/claimed-accounts"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { getCheckerVisibility, isGeneratorVisible } from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Free Amazon Prime Account — Cookies Mo",
  description:
    "Claim a free, working Amazon Prime account. Pick the country you want, complete one quick step, and your account is checked live and revealed instantly.",
}

// Always read the live pool so plan/country counts reflect the current database.
export const dynamic = "force-dynamic"

export default async function PrimeAccountGeneratorPage() {
  // Both reads are scoped to the Prime pool / Prime "already received" cookie.
  const [ip, deviceId] = await Promise.all([requestIp(), readDeviceId()])
  const [options, claimed, visibility, passMode, pass] = await Promise.all([
    getPoolOptions("prime"),
    listClaimedAccounts("prime"),
    getCheckerVisibility(),
    isAccessPassMode(),
    getPass(deviceId),
  ])

  if (passMode && !pass.valid) redirect("/unlock?service=prime")
  const accessPass = { mode: passMode, active: pass.valid, expiresAt: pass.expiresAt }
  const codeLimits = pass.accessCodeId ? await getAccessCodeLimits(pass.accessCodeId, "prime") : null
  const allowance = await claimAllowance("prime", ip, deviceId, undefined, codeLimits ?? undefined)

  // Admin hid this generator — show a friendly notice (before the access-pass
  // redirect so a hidden page never bounces to /unlock).
  if (!isGeneratorVisible(visibility, "prime")) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader service="prime" />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Free Prime Account" noun="account generator" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  // If this visitor is already at the Prime cap, show the countdown on load.
  const initialBlock = allowance.allowed
    ? null
    : { resetMs: allowance.resetMs, label: allowance.label, limit: allowance.limit }

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" service="prime" />

      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Intro */}
        <div className="mb-10 flex flex-col gap-4 anim-condense">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            Free · Verified · Instant
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl">
            Claim a free{" "}
            <span className="inline-block border border-border bg-primary px-2 text-primary-foreground shadow-lg">
              Prime
            </span>{" "}
            account
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Choose the country you want below. Every Amazon Prime account is{" "}
            <span className="font-semibold text-accent">checked live</span> the moment you claim it, so you only ever
            get one that actually works.
          </p>
        </div>

        {!passMode && (
          <Link
            href="/unlock-guide"
            className="mb-8 flex items-center justify-between gap-4 border border-border bg-card p-4 shadow-lg transition-transform sm:p-5"
          >
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold uppercase tracking-tight text-foreground">
                How to unlock — quick guide
              </span>
              <span className="text-xs font-medium leading-relaxed text-muted-foreground">
                Open the tasks, close the tabs, wait about{" "}
                <span className="font-semibold text-foreground">60 seconds</span>. Step-by-step guide + video tutorials
                inside.
              </span>
            </div>
            <BookOpen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        )}

        <AccountSelection
          plans={options.plans}
          countries={options.countries}
          combos={options.combos}
          untagged={options.untagged}
          displayCombos={options.displayCombos}
          displayUntagged={options.displayUntagged}
          service="prime"
          showPlanSelection={false}
          initialBlock={initialBlock}
          accessPass={accessPass}
          allowance={allowance}
        />

        <ClaimedAccounts initial={claimed} service="prime" />
      </div>

      <div className="mt-auto">
        <SiteFooter visibility={visibility} />
      </div>
    </main>
  )
}
