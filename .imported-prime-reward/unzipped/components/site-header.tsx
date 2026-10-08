import Link from "next/link"
import { TerminalSquare, Gift } from "lucide-react"
import { ModeToggle } from "@/components/mode-toggle"
import { CookieMark } from "@/components/cookie-mark"

// Shared Terminal Noir title bar used across every page (home, account generator,
// reward callback, and the info pages) so the chrome is identical everywhere.
// The logo always links home; the right side carries a CTA and a live status
// badge. `width` matches each page's content container so the header contents
// align with the body below it.
const SERVICE_CONFIG = {
  netflix: { subtitle: "best cookies checker", home: "/netflix", generator: "/account-generator" },
  prime: { subtitle: "best cookies checker", home: "/prime", generator: "/prime/account-generator" },
  crunchyroll: { subtitle: "best cookies checker", home: "/crunchyroll", generator: "/crunchyroll/account-generator" },
} as const

const CTA_BASE = "press inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs tracking-wide transition-colors"
const CTA_PRIMARY = `${CTA_BASE} bg-primary text-primary-foreground hover:bg-primary/90`
const CTA_GHOST = `${CTA_BASE} border border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground`

export function SiteHeader({
  width = "max-w-6xl",
  cta = "free-account",
  service = "netflix",
}: {
  width?: string
  cta?: "free-account" | "checker" | "none" | "multi-service"
  service?: "netflix" | "prime" | "crunchyroll"
}) {
  const cfg = SERVICE_CONFIG[service]
  return (
    <header className="sticky top-0 z-30 anim-condense border-b border-border glass-strong">
      <div className={`mx-auto flex w-full ${width} items-center gap-3 px-4 py-3 sm:px-6`}>
        <Link href="/" className="flex items-center gap-3" aria-label="Cookies Mo home">
          <div className="size-10 shrink-0 overflow-hidden rounded-md border border-border">
            <CookieMark />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight text-foreground sm:text-base">Cookies Mo</span>
            <span className="text-[11px] tracking-widest text-muted-foreground">{cfg.subtitle}</span>
          </div>
        </Link>
        {cta === "checker" ? (
          <Link href={cfg.home} className={`ml-auto ${CTA_PRIMARY}`}>
            <TerminalSquare className="size-3.5" aria-hidden />
            Cookies Checker
          </Link>
        ) : cta === "free-account" ? (
          <Link href={cfg.generator} className={`ml-auto ${CTA_PRIMARY}`}>
            <Gift className="size-3.5" aria-hidden />
            {service === "prime"
              ? "Free Prime Account"
              : service === "crunchyroll"
                ? "Free Crunchyroll Account"
                : "Free Netflix Account"}
          </Link>
        ) : cta === "multi-service" ? (
          <nav className="ml-auto flex items-center gap-2" aria-label="Free account links">
            <Link href="/account-generator" className={CTA_PRIMARY}>
              <Gift className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Free </span>Netflix
            </Link>
            <Link href="/prime/account-generator" className={CTA_GHOST}>
              <Gift className="size-3.5 text-primary" aria-hidden />
              <span className="hidden sm:inline">Free </span>Prime
            </Link>
            <Link href="/crunchyroll/account-generator" className={CTA_GHOST}>
              <Gift className="size-3.5 text-primary" aria-hidden />
              <span className="hidden sm:inline">Free </span>Crunchyroll
            </Link>
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-[11px] tracking-widest text-muted-foreground sm:inline-flex">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            200 ok · secure
          </span>
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
