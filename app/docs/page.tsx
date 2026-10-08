import type { Metadata } from "next"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { DocsContent, DOC_SECTIONS } from "@/components/docs/docs-content"
import { DocsToc } from "@/components/docs/docs-toc"

// Pure static reference content — prerender as a CDN asset (no per-visit function).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "Documentation — How Cookies Mo Works",
  description:
    "Full technical documentation for Cookies Mo: how the cookie checkers, supported formats, account generators, live verification, random distribution, rate limits, and security all work end to end.",
}

export default function DocsPage() {
  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="none" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Hero */}
        <div className="mb-10 flex max-w-3xl flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            Documentation · Full System
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl">
            How everything works
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            A complete, end-to-end reference for Cookies Mo — from how a single cookie is verified against the real
            service, to how thousands are checked in bulk, to how free accounts are unlocked, verified live, and handed
            out fairly at random. Every claim here reflects how the app actually behaves.
          </p>
        </div>

        {/* Two-column: sticky TOC + content. Single column on mobile. */}
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <DocsToc sections={DOC_SECTIONS} />
          <DocsContent />
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}
