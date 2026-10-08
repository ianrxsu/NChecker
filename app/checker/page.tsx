import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { SmartChecker } from "@/components/checker/smart-checker"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import {
  getCheckerVisibility,
  isSmartCheckerVisible,
  smartCheckerServices,
  smartBulkAllowed,
} from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Smart Checker — Cookies Mo",
  description:
    "One checker for Netflix, Prime, and Crunchyroll. Paste any cookie and we auto-detect the service, or pick one yourself. Check a single cookie or a whole list. Nothing is saved.",
}

// Read the admin visibility switch live on every request so enabling/disabling the
// smart checker takes effect instantly.
export const dynamic = "force-dynamic"

export default async function CheckerPage() {
  redirect("/account-generator")
  const visibility = await getCheckerVisibility()

  // Gated behind the admin opt-in switch (and the master hide). When off, show the
  // same friendly "unavailable" notice the classic pages use.
  if (!isSmartCheckerVisible(visibility)) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Smart Checker" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  const services = smartCheckerServices(visibility)
  const bulkServices = services.filter((svc) => smartBulkAllowed(visibility, svc))

  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Intro */}
        <div className="mb-10 flex flex-col gap-4 anim-condense">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground">
            <span className="size-2 bg-accent" aria-hidden />
            One checker · Every service
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl">
            The{" "}
            <span className="inline-block border border-border bg-primary px-2 text-primary-foreground shadow-lg">
              smart
            </span>{" "}
            all-in-one checker
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Paste any <span className="font-semibold text-accent">Netflix</span>,{" "}
            <span className="font-semibold text-accent">Prime</span>, or{" "}
            <span className="font-semibold text-accent">Crunchyroll</span> cookie — we auto-detect the service for you,
            or you can pick one yourself. Check a single cookie or a whole list. Nothing is saved.
          </p>
        </div>

        <SmartChecker services={services} bulkServices={bulkServices} linksOnly={visibility.linksOnly} />
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}
