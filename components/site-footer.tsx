import { Lock } from "lucide-react"
import { SoundToggle } from "@/components/sound-toggle"
import { CookieMark } from "@/components/cookie-mark"
import type { CheckerVisibility } from "@/lib/checker-visibility"

// `width` matches the page's body container so the footer's inner content lines
// up with the cards above it (defaults to the home page width).
// Reuse the caller's config, or load it so every public footer respects admin settings.
export async function SiteFooter({ width = "max-w-6xl", visibility: providedVisibility }: { width?: string; visibility?: CheckerVisibility }) {
  return (
    <footer className="mt-8 border-t border-border bg-card text-card-foreground">
      <div className={`mx-auto w-full ${width} px-4 py-12 sm:px-6`}>
        <div className="flex flex-wrap items-start justify-between gap-10">
          {/* Brand block keeps a wider readable measure while the navigation
              columns align to the same top edge at desktop widths. */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="size-10 shrink-0 overflow-hidden rounded-md border border-border">
                <CookieMark />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-base font-semibold tracking-tight text-foreground">Cookies Mo</span>
                <span className="text-[11px] tracking-widest text-muted-foreground">streaming account generators</span>
              </div>
            </div>
            <p className="max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
              Your streaming tools, in one place. Clear checks, flexible formats, and guidance when you need it.
            </p>
            <SoundToggle />
          </div>
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
