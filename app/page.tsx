import type { Metadata } from "next"
import Link from "next/link"
import { TerminalSquare, Gift, ShieldCheck, Zap, Layers, Globe, ArrowRight, CheckCircle2 } from "lucide-react"
import { SiteFooter } from "@/components/site-footer"
import { CookieMark } from "@/components/cookie-mark"
import { ModeToggle } from "@/components/mode-toggle"
import { getCheckerVisibility, isCheckerVisible, isGeneratorVisible, type CheckerService } from "@/lib/checker-visibility"

// Marketing hub. Kept CDN-cached via ISR (not fully static) so it can drop links
// to checkers an admin has hidden without re-rendering on every visit — the
// visibility config is read at most once per revalidation window.
export const revalidate = 30

export const metadata: Metadata = {
  title: "Cookies Mo — Best Cookies Checker",
  description:
    "Cookies Mo checks whether your Netflix, Amazon Prime, and Crunchyroll cookies still work — one at a time or thousands at once. Instant working-or-expired results, plus free accounts to claim.",
}

// Brand landing page for the root URL. Routes visitors to the three checkers
// (/netflix, /prime, /crunchyroll) and the three free account generators.
// Terminal Noir design system: pure-black canvas, single teal accent, monospace.

const CHECKERS = [
  {
    name: "Netflix Checker",
    tag: "working or expired — instantly",
    href: "/netflix",
    service: "netflix",
    blurb:
      "Paste one Netflix cookie or a whole list — in any format. Each one is tested live against Netflix, and for the ones that still log in you'll see the plan, country, and profiles too.",
    cta: "Open Netflix Checker",
  },
  {
    name: "Prime Checker",
    tag: "amazon prime video",
    href: "/prime",
    service: "prime",
    blurb:
      "Drop in your Amazon Prime Video cookies, in any format. We check each one live and instantly show you which accounts still work, plus their region and membership.",
    cta: "Open Prime Checker",
  },
  {
    name: "Crunchyroll Checker",
    tag: "crunchyroll premium",
    href: "/crunchyroll",
    service: "crunchyroll",
    blurb:
      "Test Crunchyroll cookies in seconds. A cookie only passes when the account has a real, active premium membership — so a \u201cworking\u201d result always means genuine premium access.",
    cta: "Open Crunchyroll Checker",
  },
] as const satisfies readonly { service: CheckerService; [k: string]: unknown }[]

const GENERATORS = [
  {
    service: "netflix",
    name: "Free Netflix Account",
    tag: "pick plan & country",
    href: "/account-generator",
    blurb:
      "Choose the plan and country you want, complete one quick step, and claim a working Netflix account — checked live the moment it's revealed.",
    cta: "Get Netflix Account",
  },
  {
    service: "prime",
    name: "Free Prime Account",
    tag: "pick your country",
    href: "/prime/account-generator",
    blurb:
      "Choose your country, complete one quick step, and claim a working Amazon Prime account — verified live so the one you get actually works.",
    cta: "Get Prime Account",
  },
  {
    service: "crunchyroll",
    name: "Free Crunchyroll Account",
    tag: "random · limited stock",
    href: "/crunchyroll/account-generator",
    blurb:
      "Stock is limited, so you get a random premium account — complete one quick step and it's checked live right before it's revealed to you.",
    cta: "Get Crunchyroll Account",
  },
] as const satisfies readonly { service: CheckerService; [k: string]: unknown }[]

const FEATURES = [
  {
    icon: Zap,
    title: "Instant results",
    body: "Every cookie is tested against the real service, so you get a clear answer: still working or expired.",
  },
  {
    icon: Layers,
    title: "One or thousands",
    body: "Paste a single cookie, or drop in whole files and folders — even zipped ones. We read them all.",
  },
  {
    icon: Globe,
    title: "Any format works",
    body: "However your cookies were saved, just paste them in. No cleanup or formatting needed on your end.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing kept",
    body: "Your cookies are used for the check and then gone. Nothing is saved when you use the public checker.",
  },
] as const

export default async function LandingPage() {
  const visibility = await getCheckerVisibility()
  const visibleCheckers = CHECKERS.filter((c) => isCheckerVisible(visibility, c.service))
  const visibleGenerators = GENERATORS.filter((g) => isGeneratorVisible(visibility, g.service))

  return (
    <main className="min-h-svh text-foreground">
      {/* Header */}
      <header className="sticky top-10 z-30 anim-condense border-b border-border glass-strong">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Cookies Mo home">
            <div className="size-10 shrink-0 overflow-hidden rounded-md border border-border">
              <CookieMark />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight text-foreground sm:text-base">Cookies Mo</span>
              <span className="text-[11px] tracking-widest text-muted-foreground">best cookies checker</span>
            </div>
          </Link>
          {/* Header tabs are quick links to the free account generators the admin
              has left visible. Hidden entirely if all three are hidden. */}
          {visibleGenerators.length > 0 && (
            <nav className="ml-auto hidden items-center gap-2 sm:flex" aria-label="Free account generators">
              {visibleGenerators.map((g) => (
                <Link
                  key={g.href}
                  href={g.href}
                  className="press inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <Gift className="size-3.5 text-primary" aria-hidden />
                  {g.service}
                </Link>
              ))}
            </nav>
          )}
          {/* Light/dark switcher — sits at the far right. `ml-auto` on mobile (nav
              hidden) and on desktop when no generator nav is shown; sits right after
              the nav on desktop when it is present. */}
          <div className={visibleGenerators.length > 0 ? "ml-auto sm:ml-0" : "ml-auto"}>
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        {/* Hero */}
        <section className="mb-16 flex flex-col gap-5 anim-condense">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-[11px] tracking-widest text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            netflix · amazon prime · crunchyroll
          </span>
          <h1 className="max-w-4xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
            <span className="text-muted-foreground">{">_ "}</span>the best <span className="text-primary">cookies</span>{" "}
            checker<span className="tc-blink text-primary">_</span>
          </h1>
          <p className="max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Find out which of your cookies still work in seconds — check one or thousands at once. Just paste
            them in, supported all formats. You can even claim a free account. Pick a tool to get started.
          </p>
          {/* Only surface CTAs for checkers that are publicly visible. The first
 visible one gets the primary treatment. */}
          {visibleCheckers.length > 0 && (
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              {visibleCheckers.map((c, i) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className={
                    i === 0
                      ? "hover-lift press glow-cyan inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-semibold tracking-wide text-primary-foreground"
                      : "hover-lift press inline-flex items-center justify-center gap-2 rounded-md border border-border bg-secondary px-5 py-3 text-sm font-medium tracking-wide text-foreground"
                  }
                >
                  <TerminalSquare className="size-4" aria-hidden />
                  {c.name}
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Checkers — omitted entirely when an admin has hidden all of them. */}
        {visibleCheckers.length > 0 && (
          <section className="mb-16">
            <SectionLabel>checkers</SectionLabel>
            <div className="grid gap-5 md:grid-cols-2">
              {visibleCheckers.map((c) => (
                <Link key={c.href} href={c.href} className="hover-lift group flex flex-col gap-4 rounded-xl glass p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
                      <TerminalSquare className="size-5" aria-hidden />
                    </div>
                    <div className="flex flex-col leading-tight">
                      <span className="text-lg font-semibold tracking-tight text-foreground">{c.name}</span>
                      <span className="text-[11px] tracking-widest text-muted-foreground">{c.tag}</span>
                    </div>
                  </div>
                  <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{c.blurb}</p>
                  <span className="mt-auto inline-flex items-center gap-2 text-sm font-medium tracking-wide text-primary">
                    {c.cta}
                    <ArrowRight className="size-4 transition-transform group-" aria-hidden />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Generators — only those the admin has left visible. */}
        {visibleGenerators.length > 0 && (
        <section className="mb-16">
          <SectionLabel>free account generators</SectionLabel>
          <div className="grid gap-5 md:grid-cols-3">
            {visibleGenerators.map((g) => (
              <Link key={g.href} href={g.href} className="hover-lift group flex flex-col gap-4 rounded-xl glass p-6">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
                    <Gift className="size-5" aria-hidden />
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className="text-base font-semibold tracking-tight text-foreground">{g.name}</span>
                    <span className="text-[11px] tracking-widest text-muted-foreground">{g.tag}</span>
                  </div>
                </div>
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{g.blurb}</p>
                <span className="mt-auto inline-flex items-center gap-2 text-sm font-medium tracking-wide text-primary">
                  {g.cta}
                  <ArrowRight className="size-4 transition-transform group-" aria-hidden />
                </span>
              </Link>
            ))}
          </div>
        </section>
        )}

        {/* Features */}
        <section>
          <SectionLabel>why cookies mo</SectionLabel>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex flex-col gap-3 rounded-xl glass-subtle p-5">
                <div className="flex size-10 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
                  <f.icon className="size-5" aria-hidden />
                </div>
                <h3 className="text-base font-semibold tracking-tight text-foreground">{f.title}</h3>
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Trust strip */}
        <section className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl glass-subtle px-6 py-4">
          {["Instant working-or-expired results", "Upload whole files & folders", "Nothing saved"].map((item) => (
            <span key={item} className="inline-flex items-center gap-2 text-sm text-foreground">
              <CheckCircle2 className="size-4 text-primary" aria-hidden />
              {item}
            </span>
          ))}
        </section>
      </div>

      <SiteFooter visibility={visibility} />
    </main>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-5 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
      <span className="text-primary">{"//"}</span>
      {children}
    </h2>
  )
}
