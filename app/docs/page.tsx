import type { Metadata } from "next"
import { ArrowUpRight, PlayCircle } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

export const revalidate = 300

export const metadata: Metadata = {
  title: "Video guides — Cookies Mo",
  description: "Watch the unlock guide and cookie usage guide for Cookies Mo.",
}

const guides = [
  { id: "unlock-guide", title: "Unlock guide", description: "Follow the unlock process step by step.", video: "s921es" },
  { id: "cookies-guide", title: "Cookies guide", description: "Learn how to use the cookies from your account.", video: "emuh9w" },
]

export default function DocsPage() {
  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="multi-service" />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-12 sm:px-6 sm:py-16">
        <header className="public-enter flex flex-col items-center gap-4 text-center">
          <span className="text-sm font-semibold text-primary">Watch. Follow. Enjoy.</span>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">A little guidance.</h1>
          <p className="text-pretty text-lg text-muted-foreground">Two short videos to help you get started.</p>
        </header>
        <div className="grid gap-6 lg:grid-cols-2">
          {guides.map((guide) => (
            <section key={guide.id} id={guide.id} className="public-enter overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
              <div className="flex flex-col gap-3 p-6">
                <PlayCircle className="size-6 text-primary" aria-hidden />
                <h2 className="text-2xl font-semibold tracking-tight">{guide.title}</h2>
                <p className="text-base text-muted-foreground">{guide.description}</p>
              </div>
              <div className="aspect-video bg-muted">
                <iframe src={`https://streamable.com/e/${guide.video}?loop=0`} title={guide.title} allow="fullscreen; picture-in-picture" allowFullScreen className="size-full border-0" />
              </div>
              <div className="p-5"><a href={`https://streamable.com/${guide.video}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">Open video in a new tab<ArrowUpRight className="size-4" aria-hidden /></a></div>
            </section>
          ))}
        </div>
      </div>
      <SiteFooter />
    </main>
  )
}
