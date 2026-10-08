import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Gift, PlayCircle } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { ServiceDirectory } from "@/components/service-directory"
import { getCheckerVisibility, isCheckerVisible, isGeneratorVisible } from "@/lib/checker-visibility"

// Marketing hub. Kept CDN-cached via ISR so it can drop links to tools an admin has hidden.
export const revalidate = 300
export const metadata: Metadata = {
  title: "Cookies Mo — Streaming account generators",
  description: "Explore Netflix, Prime Video, and Crunchyroll account generators. Choose your service and follow the unlock steps.",
}

const SERVICES = [
  { service: "netflix", name: "Netflix", note: "Plans, profiles & country", href: "/netflix", generator: "/account-generator", description: "Check session validity and see the plan, country, and available profiles.", accountDescription: "Choose your plan and country. Find an account that fits your next watch." },
  { service: "prime", name: "Prime Video", note: "Membership & region", href: "/prime", generator: "/prime/account-generator", description: "Check your Prime Video cookies and view membership and region details.", accountDescription: "Pick an available country and follow the steps to unlock your account." },
  { service: "crunchyroll", name: "Crunchyroll", note: "Premium membership", href: "/crunchyroll", generator: "/crunchyroll/account-generator", description: "Find out whether your session has an active premium membership.", accountDescription: "Discover a randomly selected premium account from the available stock." },
] as const

export default async function LandingPage() {
  const visibility = await getCheckerVisibility()
  const checkers = SERVICES.filter((s) => isCheckerVisible(visibility, s.service))
  const generators = SERVICES.filter((s) => isGeneratorVisible(visibility, s.service))
  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta={generators.length ? "multi-service" : "none"} />
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <section className="public-enter flex flex-col items-center gap-6 py-12 text-center sm:py-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-2 text-sm font-medium text-primary"><Gift className="size-4" aria-hidden />Your next account starts here</span>
          <h1 className="home-headline max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-7xl">Pick your service.<br /><span className="text-primary">Find your next watch.</span></h1>
          <p className="max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">Netflix, Prime Video, or Crunchyroll. Explore available accounts, follow the unlock steps, and make your pick.</p>
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Link href={generators.length ? "#accounts" : "/docs"} className="public-action inline-flex items-center gap-3 rounded-full bg-primary px-6 py-3.5 font-semibold text-primary-foreground">{generators.length ? "Explore accounts" : "Watch the guides"}<ArrowRight className="size-5" aria-hidden /></Link>
            {generators.length > 0 && <Link href="/docs" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary"><PlayCircle className="size-5" aria-hidden />Watch the guides</Link>}
          </div>
        </section>

        {/* Only surface tools the admin has left publicly visible. */}
        {generators.length > 0 ? <ServiceDirectory id="accounts" eyebrow="ACCOUNT GENERATORS" title="What are you watching?" description="Choose a service to explore available accounts." services={generators} accounts /> : <section id="accounts" className="rounded-2xl border border-border bg-card p-8 text-center text-card-foreground"><h2 className="text-xl font-semibold">Accounts are currently unavailable</h2><p className="mt-3 text-muted-foreground">Please check back later. The video guides are still available.</p></section>}
        {checkers.length > 0 && <ServiceDirectory id="tools" eyebrow="COOKIE CHECKERS" title="Already have cookies?" description="Choose a service to check your session." services={checkers} />}

        <p className="pb-8 text-center text-sm text-muted-foreground">Use accounts you own or have permission to access. Availability varies by service.</p>
      </div>
      <SiteFooter visibility={visibility} />
    </main>
  )
}
