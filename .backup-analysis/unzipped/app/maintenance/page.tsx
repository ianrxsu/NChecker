import type { Metadata } from "next"
import { Wrench } from "lucide-react"
import { getMaintenanceState } from "@/lib/maintenance-mode"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Down for maintenance — Cookies Mo",
  description: "Cookies Mo is temporarily offline for maintenance. Please check back shortly.",
  robots: { index: false, follow: false },
}

// Shown whenever the admin kill switch is on. The root middleware rewrites every
// public page here with a 503, so this is the only thing visitors can see.
export default async function MaintenancePage() {
  const { message } = await getMaintenanceState()

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-lg border border-border bg-card p-8 shadow-lg sm:p-10">
        <div className="flex size-14 items-center justify-center border border-border bg-primary text-primary-foreground shadow-lg">
          <Wrench className="size-7" aria-hidden />
        </div>

        <h1 className="mt-6 text-balance text-3xl font-semibold uppercase tracking-tight sm:text-4xl">
          Down for maintenance
        </h1>

        <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
          {message ??
            "Cookies Mo is temporarily offline while we make some improvements. Everything will be back shortly — thanks for your patience."}
        </p>

        <div className="mt-8 inline-flex items-center gap-2 border border-border bg-accent px-4 py-2 text-xs font-semibold uppercase tracking-widest text-accent-foreground">
          <span className="inline-block size-2 animate-pulse rounded-full bg-accent-foreground" aria-hidden />
          We&apos;ll be right back
        </div>
      </section>
    </main>
  )
}
