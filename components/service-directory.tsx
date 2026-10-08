import Link from "next/link"
import { ArrowUpRight, Check, Gift, Play, ScanLine } from "lucide-react"

type Service = { service: string; name: string; note: string; href: string; generator: string; description: string; accountDescription: string }

export function ServiceDirectory({ id, eyebrow, title, description, services, accounts = false }: {
  id: string; eyebrow: string; title: string; description: string; services: readonly Service[]; accounts?: boolean
}) {
  return (
    <section id={id} className="flex flex-col gap-7 pb-16 sm:pb-20">
      <div className="public-enter flex flex-col items-center gap-3 text-center">
        <span className="text-sm font-medium tracking-wider text-primary">{eyebrow}</span>
        <h2 className="text-balance text-3xl font-semibold tracking-tight">{title}</h2>
        <p className="text-base text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-5">
        {services.map((service, index) => (
          <Link key={service.service} href={accounts ? service.generator : service.href} style={{ animationDelay: `${index * 90}ms` }} className="public-service-card public-enter group flex w-full max-w-md flex-col gap-6 rounded-2xl border border-border bg-card p-6 text-card-foreground hover:border-primary/50 md:w-[calc(50%-0.625rem)] md:max-w-none lg:w-auto lg:flex-1 lg:basis-64 sm:p-7">
            <div className="flex items-center justify-between gap-3">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">{accounts ? <Gift className="size-5" aria-hidden /> : <Play className="size-5" aria-hidden />}</span>
              <ArrowUpRight className="size-5 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
            </div>
            <div className="flex flex-col gap-3"><h3 className="text-2xl font-semibold tracking-tight">{service.name}</h3><p className="text-base leading-relaxed text-muted-foreground">{accounts ? service.accountDescription : service.description}</p></div>
            {!accounts && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="size-4 text-primary" aria-hidden />{service.note}</span>}
            <span className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-5 text-sm font-semibold text-primary">{accounts ? `Open ${service.name} generator` : "Open checker"}{accounts ? <ArrowUpRight className="size-4" aria-hidden /> : <ScanLine className="size-4" aria-hidden />}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
