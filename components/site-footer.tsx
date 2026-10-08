import { Lock } from "lucide-react"
import { SoundToggle } from "@/components/sound-toggle"
import type { CheckerVisibility } from "@/lib/checker-visibility"

export async function SiteFooter({ width = "max-w-6xl", visibility: _visibility }: { width?: string; visibility?: CheckerVisibility }) {
  return (
    <footer className="mt-12 border-t border-border bg-card text-card-foreground">
      <div className={`mx-auto flex w-full ${width} flex-col items-center gap-5 px-4 py-10 text-center sm:px-6`}>
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold tracking-[0.18em] text-foreground">NETFLIX CHECKER</p>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            Fast, focused session checks with clear results and private account handling.
          </p>
        </div>
        <SoundToggle />
        <div className="flex flex-col items-center gap-2 border-t border-border pt-5 text-[11px] text-muted-foreground sm:flex-row sm:gap-4">
          <span className="inline-flex items-center gap-1.5 tracking-wide">
            <Lock className="size-3.5 text-primary" aria-hidden />
            Developed by kasumi.
          </span>
          <span>&copy; {new Date().getFullYear()} Netflix Checker</span>
        </div>
      </div>
    </footer>
  )
}
