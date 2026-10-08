import type { Metadata } from "next"
import { CheckerShell } from "@/components/checker/checker-shell"
import { CheckerUnavailable } from "@/components/checker/checker-unavailable"
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
        <SiteHeader />
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <CheckerUnavailable title="Netflix Checker" />
        </div>
        <SiteFooter visibility={visibility} />
      </main>
    )
  }

  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Intro */}
        <div className="mb-10 flex flex-col gap-4 anim-condense">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            Check · Sort · Understand
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-6xl">
            Check your{" "}
            <span className="inline-block border border-border bg-primary px-2 text-primary-foreground shadow-lg">
              Netflix
            </span>{" "}
            cookies in seconds
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Check one cookie or a whole list at once, and instantly see which ones still work. Paste them in{" "}
            <span className="font-semibold text-accent">however they were saved</span> — we sort out the formatting for
            you, so there's <span className="font-semibold text-accent">nothing to clean up</span> first. Nothing is
            saved.
          </p>
        </div>

        <CheckerShell initialMode={initialMode} basePath="/netflix" allowBulk={bulkVisible} linksOnly={visibility.linksOnly} autoProxyScrapeEnabled={visibility.autoProxyScrapeEnabled} />
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}
