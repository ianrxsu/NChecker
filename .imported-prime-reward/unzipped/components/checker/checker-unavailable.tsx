import Link from "next/link"
import { EyeOff, ArrowLeft } from "lucide-react"

// Shown on a public checker/generator route when an admin has hidden it. It's a
// calm "temporarily unavailable" notice rather than a hard 404, so returning
// visitors understand the tool still exists and may come back. `noun` tailors the
// body copy (e.g. "checker" vs "account generator").
export function CheckerUnavailable({ title, noun = "checker" }: { title: string; noun?: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-5 border border-border bg-card px-6 py-14 text-center shadow-lg">
      <span className="flex size-14 items-center justify-center border border-border bg-muted text-foreground ">
        <EyeOff className="size-7" aria-hidden />
      </span>
      <h1 className="text-balance text-3xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground">
        {title} is unavailable
      </h1>
      <p className="max-w-md text-pretty text-base font-medium leading-relaxed text-muted-foreground">
        This {noun} is temporarily turned off. Please check back later — the other tools may still be available in the
        meantime.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-2 border border-border bg-primary px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-primary-foreground shadow-lg transition-transform "
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to home
      </Link>
    </div>
  )
}
