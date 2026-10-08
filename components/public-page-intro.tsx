import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

export function PublicPageIntro({ title, description, category = "Cookie checker", guide = "/formats", guideLabel = "Supported formats" }: {
  title: string; description: string; category?: string; guide?: string; guideLabel?: string
}) {
  return <div className="flex flex-col gap-5 pb-10 sm:pb-12">
    <Link href="/" className="w-fit text-sm text-muted-foreground hover:text-primary">Home / {category}</Link>
    <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div className="flex max-w-3xl flex-col gap-4"><h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{title}</h1><p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{description}</p></div>
      <Link href={guide} className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-card-foreground hover:border-primary/50 lg:self-end">{guideLabel}<ArrowUpRight className="size-4" aria-hidden /></Link>
    </div>
  </div>
}
