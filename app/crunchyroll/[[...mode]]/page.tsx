import type { Metadata } from "next"
import { PublicPageIntro } from "@/components/public-page-intro"
import { CheckerShell } from "@/components/checker/checker-shell"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { getCheckerVisibility, isCheckerVisible, isBulkVisible } from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Crunchyroll Checker — Cookies Mo",
  description:
    "Cookies Mo, the best cookies checker. Check one Crunchyroll cookie or a whole list at once and instantly see which still work. A cookie counts as working only when the account has an active premium membership. Nothing is saved.",
}

// Read the admin visibility switch live on every request so hiding a checker takes
// effect instantly (no cached/stale gate).
export const dynamic = "force-dynamic"

// Path-based mode: /crunchyroll = single, /crunchyroll/bulk = bulk. Read on the
// SERVER so the correct checker is server-rendered on first paint. Mirrors the
// Netflix and Prime pages, but every check is routed at Crunchyroll.
export default async function CrunchyrollPage({ params }: { params: Promise<{ mode?: string[] }> }) {
  const { mode } = await params
  const requestedBulk = mode?.[0] === "bulk"

  const visibility = await getCheckerVisibility()
  const checkerVisible = isCheckerVisible(visibility, "crunchyroll")
  const bulkVisible = isBulkVisible(visibility, "crunchyroll")
  const initialMode = requestedBulk && bulkVisible ? "bulk" : "single"

  if (!checkerVisible) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader service="crunchyroll" cta="free-account" />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Crunchyroll Checker" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  return (
    <main className="min-h-svh text-foreground">
      {/* The Crunchyroll generator links from the header CTA. */}
      <SiteHeader service="crunchyroll" cta="free-account" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Intro */}
        <PublicPageIntro title="Crunchyroll cookie checker" description="Check your session for an active premium membership. Working results indicate premium access, not just a signed-in account." />

        <CheckerShell
          initialMode={initialMode}
          service="crunchyroll"
          storageKey="crunchyroll-public"
          basePath="/crunchyroll"
          allowBulk={bulkVisible}
          linksOnly={visibility.linksOnly}
          autoProxyScrapeEnabled={visibility.autoProxyScrapeEnabled}
        />
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}
