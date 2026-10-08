import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { LockKeyhole, CheckCircle2 } from "lucide-react"
import { redis, redisEnabled } from "@/lib/redis"
import { shortXLinksStepKey } from "@/lib/shortxlinks"
import { getRewardSessionState } from "@/lib/reward-store"
import type { GeneratorService } from "@/lib/check-via-proxies"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { UnlockLinkButton } from "@/components/unlock-link-button"

export const dynamic = "force-dynamic"

const labels: Record<GeneratorService, string> = { netflix: "Netflix", prime: "Prime Video", crunchyroll: "Crunchyroll" }

export default async function UnlockStepTwoPage() {
  const token = (await cookies()).get("unlock_flow_token")?.value?.trim() ?? ""
  const state = redisEnabled && token ? await redis.get<{ step: 2; url: string }>(shortXLinksStepKey(token)) : null
  const session = token ? await getRewardSessionState(token) : { state: "missing" as const }
  const service = session.state !== "missing" && typeof session.service === "string" && session.service in labels ? session.service as GeneratorService : "netflix"

  // Step 2 is never reachable by guessing a URL: the signed Step 1 callback
  // creates this short-lived server-side record first.
  if (!state?.url || session.state === "missing") redirect("/unlock")

  return <main className="flex min-h-svh flex-col text-foreground">
    <SiteHeader cta="checker" service={service} />
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex items-center gap-3 text-accent"><LockKeyhole className="size-5" aria-hidden /><span className="text-xs font-semibold uppercase tracking-widest">24-hour access unlock</span></div>
      <h1 className="mt-5 text-balance text-4xl font-semibold uppercase leading-none tracking-tight sm:text-5xl">Complete two quick steps</h1>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-muted-foreground">Unlock {labels[service]} access by completing 2 steps of ads provider for free. You will stay on this page until you choose to begin each step.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <div className="border border-accent bg-card p-5"><div className="flex items-center gap-2 text-accent"><span className="flex size-7 items-center justify-center bg-accent text-sm font-bold text-accent-foreground"><CheckCircle2 className="size-4" aria-hidden /></span><span className="text-sm font-semibold uppercase tracking-widest">Completed</span></div><p className="mt-4 text-sm leading-relaxed text-muted-foreground">Step 1 verification is complete.</p></div>
        <div className="border border-primary bg-card p-5"><div className="flex items-center gap-2 text-primary"><span className="flex size-7 items-center justify-center bg-primary text-sm font-bold text-primary-foreground">2</span><span className="text-sm font-semibold uppercase tracking-widest">Ready to start</span></div><p className="mt-4 text-sm leading-relaxed text-muted-foreground">Complete the Telegram bot verification.</p><UnlockLinkButton href={state.url} label="Start step 2" /></div>
      </div>
    </div>
    <SiteFooter />
  </main>
}

