import Link from "next/link"
import { Lock } from "lucide-react"
import { SoundToggle } from "@/components/sound-toggle"
import { CookieMark } from "@/components/cookie-mark"
import {
  isCheckerVisible,
  isGeneratorVisible,
  type CheckerService,
  type CheckerVisibility,
} from "@/lib/checker-visibility"

// Public checker links keyed by the service they point at, so the footer can drop
// any that an admin has hidden. Non-checker links have no service and always show.
const CHECKER_HREF_SERVICE: Record<string, CheckerService> = {
  "/netflix": "netflix",
  "/prime": "prime",
  "/crunchyroll": "crunchyroll",
}

// Public account-generator links keyed by service, so hidden generators drop out too.
const GENERATOR_HREF_SERVICE: Record<string, CheckerService> = {
  "/account-generator": "netflix",
  "/prime/account-generator": "prime",
  "/crunchyroll/account-generator": "crunchyroll",
}

const LINK_GROUPS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Checkers",
    links: [
      { label: "Home", href: "/" },
      { label: "Netflix Checker", href: "/netflix" },
      { label: "Prime Checker", href: "/prime" },
      { label: "Crunchyroll Checker", href: "/crunchyroll" },
    ],
  },
  {
    heading: "Account Generators",
    links: [
      { label: "Free Netflix Account", href: "/account-generator" },
      { label: "Free Prime Account", href: "/prime/account-generator" },
      { label: "Free Crunchyroll Account", href: "/crunchyroll/account-generator" },
    ],
  },
]

// `width` matches the page's body container so the footer's inner content lines
// up with the cards above it (defaults to the home page width).
// `visibility` (optional) lets callers that already fetched the admin config hide
// links to hidden checkers. Omitting it shows every link (the safe default for
// pages that don't read the config).
export function SiteFooter({ width = "max-w-6xl", visibility }: { width?: string; visibility?: CheckerVisibility }) {
  const groups = visibility
    ? LINK_GROUPS.map((group) => ({
        ...group,
        links: group.links.filter((link) => {
          // Drop a checker link when its service's checker is hidden.
          const checkerSvc = CHECKER_HREF_SERVICE[link.href]
          if (checkerSvc) return isCheckerVisible(visibility, checkerSvc)
          // Drop a generator link when its service's generator is hidden.
          const genSvc = GENERATOR_HREF_SERVICE[link.href]
          if (genSvc) return isGeneratorVisible(visibility, genSvc)
          // Everything else always shows.
          return true
        }),
      })).filter((group) => group.links.length > 0)
    : LINK_GROUPS

  return (
    <footer className="mt-16 border-t border-border glass-strong">
      <div className={`mx-auto w-full ${width} px-4 py-12 sm:px-6`}>
        <div className="grid items-start gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-x-16 lg:gap-y-12">
          {/* Brand block keeps a wider readable measure while the navigation
              columns align to the same top edge at desktop widths. */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="size-10 shrink-0 overflow-hidden rounded-md border border-border">
                <CookieMark />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-base font-semibold tracking-tight text-foreground">Cookies Mo</span>
                <span className="text-[11px] tracking-widest text-muted-foreground">best cookies checker</span>
              </div>
            </div>
            <p className="max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
              Instantly check whether your Netflix, Amazon Prime, and Crunchyroll cookies still work — one at a time or
              thousands at once. Paste them in any format. Nothing is saved.
            </p>
            <SoundToggle />
          </div>

          {/* Link groups — each occupies its own column alongside the brand so
 they read as an evenly-balanced row instead of clustering. */}
          {groups.map((group) => (
            <nav key={group.heading} aria-label={group.heading} className="flex min-w-0 flex-col gap-3">
              <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
                <span className="text-primary">{"//"}</span>
                {group.heading}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          <span className="inline-flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground">
            <Lock className="size-3.5 text-primary" aria-hidden />
            Developed by kasumi.
          </span>
          <span className="text-[11px] text-muted-foreground">&copy; {new Date().getFullYear()} Cookies Mo</span>
        </div>
      </div>
    </footer>
  )
}
