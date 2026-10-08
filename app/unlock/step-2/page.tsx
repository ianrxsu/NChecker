import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { ShieldCheck, ArrowRight } from "lucide-react"
import { redis, redisEnabled } from "@/lib/redis"
import { shortXLinksStepKey } from "@/lib/shortxlinks"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

export const dynamic = "force-dynamic"

export default async function UnlockStepTwoPage() {
  const token = (await cookies()).get("unlock_flow_token")?.value?.trim() ?? ""
  const state = redisEnabled && token
    ? await redis.get<{ step: 2; url: string }>(shortXLinksStepKey(token))
    : null

  // Step 2 is never reachable by guessing a URL: the signed step-1 callback
  // creates this short-lived server-side record first.
  if (!state?.url) redirect("/unlock")

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" service="netflix" />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        <div className="border border-border bg-card p-6 shadow-xl sm:p-8">
          <div className="flex items-center gap-3 text-accent">
            <ShieldCheck className="size-6" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-widest">Step 2 of 2</span>
          </div>
          <h1 className="mt-5 text-balance text-4xl font-semibold uppercase leading-none tracking-tight">Finish your unlock</h1>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
            Step 1 is complete. Complete this final verification to activate your 24-hour access.
          </p>
          <a
            href={state.url}
            className="mt-8 flex min-h-12 items-center justify-center gap-2 bg-primary px-5 text-sm font-semibold uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90"
            rel="nofollow noopener noreferrer"
          >
            Continue to step 2 <ArrowRight className="size-4" aria-hidden />
          </a>
          <p className="mt-4 text-center text-xs text-muted-foreground">This step expires automatically if not completed.</p>
        </div>
      </div>
      <SiteFooter />
    </main>
  )
}

