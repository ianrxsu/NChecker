import type { ReactNode } from "react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

// Shared chrome for the static information pages (How It Works, Formats, FAQ,
// Privacy). Keeps the brutalist header, hero, and footer identical across pages.
export function InfoPage({
  badge,
  title,
  intro,
  children,
}: {
  badge: string
  title: ReactNode
  intro: string
  children: ReactNode
}) {
  return (
    <main className="min-h-svh text-foreground">
      {/* Info pages (How It Works, Formats, FAQ, Privacy, About) omit the "Free
 Account" CTA — they're reference content, not a place to push the offer. */}
      <SiteHeader cta="none" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Wide container matches the main page; text column stays readable. */}
        <div className="mb-10 flex max-w-3xl flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            {badge}
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl">
            {title}
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">{intro}</p>
        </div>

        <div className="flex max-w-3xl flex-col gap-6">{children}</div>
      </div>

      <SiteFooter />
    </main>
  )
}

// A bordered content card used to group related explanation blocks.
export function InfoCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-5 shadow-lg sm:p-6">
      <h2 className="mb-3 text-lg font-semibold uppercase tracking-tight text-foreground">{title}</h2>
      <div className="flex flex-col gap-3 text-sm font-medium leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}
