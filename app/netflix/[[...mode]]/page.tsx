import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { unstable_noStore as noStore } from "next/cache"
import { readDeviceId } from "@/lib/device-id"
import { getPass } from "@/lib/access-pass"
import { PublicPageIntro } from "@/components/public-page-intro"
import { CheckerShell } from "@/components/checker/checker-shell"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { AccessPassCountdown } from "@/components/access-pass-countdown"
import { GeneratorPromo } from "@/components/generator-promo"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { getCheckerVisibility, isCheckerVisible, isBulkVisible } from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Netflix Checker — Cookies Mo",
  description:
    "Cookies Mo, the best cookies checker. Check one Netflix cookie or a whole list at once and instantly see which still work. Paste them in however they were saved — no cleanup needed. Nothing is saved.",
}

// Read the admin visibility switch live on every request so hiding a checker takes
// effect instantly (no cached/stale gate).
export const dynamic = "force-dynamic"

// Path-based mode: /netflix = single, /netflix/bulk = bulk. The mode is read from
// the URL segment on the SERVER so the correct checker is server-rendered on first
// paint (no client-side flash/snap). Next 16 hands params in as a Promise.
export default async function NetflixPage({ params }: { params: Promise<{ mode?: string[] }> }) {
  noStore()
  // Require a valid server-side, device-bound 24-hour pass before rendering any
  // checker UI. This runs on every request, so expiry immediately locks access.
  const pass = await getPass(await readDeviceId())
  if (!pass.valid) redirect("/unlock?service=netflix")

  const { mode } = await params
  const requestedBulk = mode?.[0] === "bulk"

  const visibility = await getCheckerVisibility()
  const checkerVisible = isCheckerVisible(visibility, "netflix")
  const bulkVisible = isBulkVisible(visibility, "netflix")
  // If bulk is hidden, fall back to single even when /netflix/bulk was requested.
  const initialMode = requestedBulk && bulkVisible ? "bulk" : "single"

  // Whole checker hidden by the admin — show a friendly notice instead.
  if (!checkerVisible) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader cta="none" />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Netflix Checker" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="free-account" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Intro */}
        <PublicPageIntro title="Netflix cookie checker" description="Check your session and understand the result. Add your cookies below to see available plan, country, and profile details." />

        <CheckerShell
          belowTelegram={
            <>
              {pass.expiresAt && <AccessPassCountdown expiresAt={pass.expiresAt} />}
              <GeneratorPromo />
            </>
          }
          initialMode={initialMode} basePath="/netflix" allowBulk={bulkVisible} linksOnly={visibility.linksOnly} autoProxyScrapeEnabled={visibility.autoProxyScrapeEnabled} />
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}
