"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { ArrowUpRight, Menu, X } from "lucide-react"
import { ModeToggle } from "@/components/mode-toggle"
import { CookieMark } from "@/components/cookie-mark"

const SERVICES = {
  netflix: { home: "/netflix", generator: "/account-generator" },
  prime: { home: "/prime", generator: "/prime/account-generator" },
  crunchyroll: { home: "/crunchyroll", generator: "/crunchyroll/account-generator" },
}
const NAV = [{ label: "Netflix checker", href: "/netflix" }]

export function SiteHeader({ width = "max-w-6xl", cta = "free-account", service = "netflix" }: {
  width?: string
  cta?: "free-account" | "checker" | "none" | "multi-service"
  service?: "netflix" | "prime" | "crunchyroll"
}) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const cfg = SERVICES[service]
  const action = cta === "checker" ? { href: cfg.home, label: "Open checker" }
    : cta === "free-account" ? { href: "https://cookiesmo.i4n.tech", label: "Account Generator" }
    : cta === "multi-service" ? { href: "/#accounts", label: "Explore accounts" } : null
  return (
    <header className="public-header sticky top-0 z-30 border-b border-border bg-background/95 text-foreground backdrop-blur-lg">
      <div className={`mx-auto flex min-h-16 w-full ${width} items-center justify-between gap-2 px-4 sm:min-h-20 sm:gap-5 sm:px-6`}>
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Cookies Mo home" onClick={() => setMenuOpen(false)}>
          <span className="size-9 overflow-hidden rounded-xl"><CookieMark /></span>
          <span className="text-lg font-semibold tracking-tight">Cookies<span className="text-primary"> Mo</span><span className="text-primary">.</span></span>
        </Link>
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Main navigation">
          {NAV.map(({ label, href }) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className="public-nav-link text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">{label}</Link>)}
        </nav>
        <div className="flex items-center gap-3">
          {action && <Link href={action.href} className="hidden items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 sm:inline-flex">{action.label}<ArrowUpRight className="size-4" aria-hidden /></Link>}
          <ModeToggle />
          <button type="button" className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground lg:hidden" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}</button>
        </div>
      </div>
      {menuOpen && <nav id="mobile-navigation" aria-label="Mobile navigation" className="flex max-h-[60dvh] flex-col overflow-y-auto overscroll-contain border-t border-border bg-background px-5 py-3 lg:hidden" onKeyDown={(event) => { if (event.key === "Escape") { setMenuOpen(false); document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')?.focus() } }}>
        {NAV.map(({ label, href }) => <Link key={href} href={href} onClick={() => setMenuOpen(false)} aria-current={pathname === href ? "page" : undefined} className="rounded-lg px-3 py-3 text-base text-foreground hover:bg-muted">{label}</Link>)}
        {action && <Link href={action.href} onClick={() => setMenuOpen(false)} className="rounded-lg px-3 py-3 font-medium text-primary">{action.label}</Link>}
      </nav>}
    </header>
  )
}
