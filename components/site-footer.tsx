import Image from "next/image"
import { Lock } from "lucide-react"
import { SoundToggle } from "@/components/sound-toggle"
import type { CheckerVisibility } from "@/lib/checker-visibility"

export async function SiteFooter({ width = "max-w-6xl", visibility: _visibility }: { width?: string; visibility?: CheckerVisibility }) {
  return (
    <footer className="mt-12 border-t border-border bg-card text-card-foreground">
      <div className={`mx-auto flex w-full ${width} flex-col items-center gap-5 px-4 py-10 text-center sm:px-6`}>
        <Image
          src="/cookies-mo-logo.png"
          alt="Cookies Mo."
          width={150}
          height={40}
          className="h-auto w-[150px]"
          priority
        />
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
