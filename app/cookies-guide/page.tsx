import type { Metadata } from "next"
import { PlayCircle } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

export const metadata: Metadata = {
  title: "How to Use Cookies — Cookies Mo",
  description: "Watch the guide for using Cookies Mo account cookies.",
}

export default function CookiesGuidePage() {
  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="multi-service" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-10 flex flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground">
            <span className="size-2 bg-accent" aria-hidden />
            Step-by-step guide
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl">
            How to use cookies
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Watch this short guide to learn how to use the cookies from your account.
          </p>
        </div>

        <section className="max-w-3xl" aria-labelledby="cookies-video-heading">
          <h2 id="cookies-video-heading" className="sr-only">Cookies usage video guide</h2>
          <div className="aspect-video w-full overflow-hidden border border-border shadow-lg">
            <iframe
              src="https://streamable.com/e/emuh9w?loop=0"
              title="Cookies usage guide"
              allow="fullscreen"
              allowFullScreen
              className="size-full"
            />
          </div>
          <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <PlayCircle className="size-4" aria-hidden />
            Watch the video guide above
          </p>
        </section>
      </div>
      <SiteFooter />
    </main>
  )
}
