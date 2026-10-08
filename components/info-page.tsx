import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRight, BookOpen } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

// Shared chrome keeps public reference pages consistent without changing their content.
export function InfoPage({ badge, title, intro, children }: { badge: string; title: ReactNode; intro: string; children: ReactNode }) {
  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="none" />
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-6 sm:py-20">
        <div className="flex max-w-3xl flex-col gap-5 pb-12">
          <Link href="/" className="text-sm text-muted-foreground hover:text-primary">Home / Resources</Link>
          <span className="text-sm font-semibold text-primary">{badge}</span>
          <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{title}</h1>
          <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{intro}</p>
        </div>
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-5">{children}</div>
          <aside className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-6 text-card-foreground lg:sticky lg:top-28">
            <BookOpen className="size-5 text-primary" aria-hidden />
            <h2 className="font-semibold">A little guidance</h2>
            <nav aria-label="Resources" className="flex flex-col gap-4 text-sm text-muted-foreground">
              {[['Unlock video', '/docs#unlock-guide'], ['Cookies video', '/docs#cookies-guide']].map(([label, href]) => <Link key={href} href={href} className="flex items-center justify-between gap-2 hover:text-primary">{label}<ArrowUpRight className="size-4" aria-hidden /></Link>)}
            </nav>
          </aside>
        </div>
      </div>
      <SiteFooter />
    </main>
  )
}

export function InfoCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="rounded-2xl border border-border bg-card p-6 text-card-foreground sm:p-8"><h2 className="pb-4 text-xl font-semibold tracking-tight">{title}</h2><div className="flex flex-col gap-4 text-base leading-relaxed text-muted-foreground">{children}</div></section>
}
