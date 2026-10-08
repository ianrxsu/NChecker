import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { ArrowRight, LockKeyhole } from "lucide-react"
import { getRewardSessionState } from "@/lib/reward-store"
import { startStepOne } from "@/app/unlock/actions"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import type { GeneratorService } from "@/lib/check-via-proxies"

export const metadata: Metadata = { title: "Unlock step 1 · Cookies Mo" }
export const dynamic = "force-dynamic"

const labels: Record<GeneratorService, string> = { netflix: "Netflix", prime: "Prime Video", crunchyroll: "Crunchyroll" }
function serviceOf(value: unknown): GeneratorService { return value === "prime" ? "prime" : value === "crunchyroll" ? "crunchyroll" : "netflix" }

export default async function StepOnePage({ searchParams }: { searchParams: Promise<{ service?: string }> }) {
  const { service: serviceParam } = await searchParams
  const service = serviceOf(serviceParam)
  const token = (await cookies()).get("unlock_flow_token")?.value?.trim() ?? ""
  const state = token ? await getRewardSessionState(token) : { state: "missing" as const }
  if (!token || state.state !== "locked" || state.purpose !== "pass" || state.service !== service) redirect(`/unlock?service=${service}`)
  const label = labels[service]

  return <main className="flex min-h-svh flex-col text-foreground">
    <SiteHeader cta="checker" service={service} />
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex items-center gap-3 text-accent"><LockKeyhole className="size-5" aria-hidden /><span className="text-xs font-semibold uppercase tracking-widest">24-hour access unlock</span></div>
      <h1 className="mt-5 text-balance text-4xl font-semibold uppercase leading-none tracking-tight sm:text-5xl">Complete two quick steps</h1>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-muted-foreground">Unlock {label} access by completing 2 steps of ads provider for free. You will stay on this page until you choose to begin each step.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <div className="border border-primary bg-card p-5"><div className="flex items-center gap-2 text-primary"><span className="flex size-7 items-center justify-center bg-primary text-sm font-bold text-primary-foreground">1</span><span className="text-sm font-semibold uppercase tracking-widest">Ready to start</span></div><p className="mt-4 text-sm leading-relaxed text-muted-foreground">Complete the original website verification.</p><form action={startStepOne} className="mt-5"><input type="hidden" name="service" value={service} /><button className="flex min-h-11 w-full items-center justify-center gap-2 bg-primary px-4 text-sm font-semibold uppercase tracking-widest text-primary-foreground hover:opacity-90">Start step 1 <ArrowRight className="size-4" aria-hidden /></button></form></div>
        <div className="border border-border bg-muted p-5 opacity-70"><div className="flex items-center gap-2 text-muted-foreground"><span className="flex size-7 items-center justify-center border border-border text-sm font-bold">2</span><span className="text-sm font-semibold uppercase tracking-widest">Locked</span></div><p className="mt-4 text-sm leading-relaxed text-muted-foreground">Step 2 unlocks only after step 1 is verified.</p></div>
      </div>
        </div>
    <SiteFooter />
  </main>
}
