import type { Metadata } from "next"
import { PublicPageIntro } from "@/components/public-page-intro"
import { CheckerShell } from "@/components/checker/checker-shell"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { getCheckerVisibility, isCheckerVisible, isBulkVisible } from "@/lib/checker-visibility"

export const metadata: Metadata = {
  title: "Amazon Prime Checker — Cookies Mo",
  description:
    "Cookies Mo, the best cookies checker. Check one Amazon Prime Video cookie or a whole list at once and instantly see which ones still work. Paste them in however they were saved. Nothing is saved.",
}

// Read the admin visibility switch live on every request so hiding a checker takes
// effect instantly (no cached/stale gate).
export const dynamic = "force-dynamic"

// Path-based mode: /prime = single, /prime/bulk = bulk. Read on the SERVER so the
// correct checker is server-rendered on first paint. Mirrors the Netflix page, but
// every check is routed at Amazon Prime via service="prime".
export default async function PrimePage({ params }: { params: Promise<{ mode?: string[] }> }) {
  const { mode } = await params
  const requestedBulk = mode?.[0] === "bulk"

  const visibility = await getCheckerVisibility()
  const checkerVisible = isCheckerVisible(visibility, "prime")
  const bulkVisible = isBulkVisible(visibility, "prime")
  const initialMode = requestedBulk && bulkVisible ? "bulk" : "single"

  if (!checkerVisible) {
    return (
      <main className="min-h-svh text-foreground">
        <SiteHeader service="prime" cta="free-account" />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Prime Checker" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader service="prime" cta="free-account" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Intro */}
        <PublicPageIntro title="Prime Video cookie checker" description="A clearer view of your Prime Video session. Add your cookies to check validity and see membership and region details." />

        <CheckerShell
          initialMode={initialMode}
          service="prime"
          storageKey="prime-public"
          basePath="/prime"
          allowBulk={bulkVisible}
          linksOnly={visibility.linksOnly}
          autoProxyScrapeEnabled={visibility.autoProxyScrapeEnabled}
        />
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}
