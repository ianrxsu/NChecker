import type { Metadata } from "next"
import { MousePointerClick, CheckSquare, X, Timer, Unlock, PlayCircle, ShieldOff } from "lucide-react"
import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { getGatewayProvider, type GatewayProvider } from "@/lib/gateway-provider"
import { isAccessPassMode } from "@/lib/access-pass"

// Depends on the admin-selected gateway provider (read from storage at runtime),
// so it can't be statically prerendered.
export const dynamic = "force-dynamic"

// Which unlock tutorials are relevant for each admin-configured gateway provider.
// A user only ever sees the gate(s) their provider can route them through, so we
// only render those sections. Primary + fallback gateways are both included.
const GUIDE_SECTIONS: Record<GatewayProvider, { shrinkearn: boolean; shortxlinks: boolean; oii: boolean; lootlabs: boolean }> = {
  // LootLabs only.
  lootlabs: { shrinkearn: false, shortxlinks: false, oii: false, lootlabs: true },
  // ShrinkEarn primary; auto-falls back to LootLabs once the IP hits its 24h cap.
  shrinkearn: { shrinkearn: true, shortxlinks: false, oii: false, lootlabs: true },
  // oii.io only (no 24h cooldown, behaves like LootLabs).
  oii: { shrinkearn: false, shortxlinks: false, oii: true, lootlabs: false },
  // ShrinkEarn primary; oii.io fallback.
  shrinkearn_then_oii: { shrinkearn: true, shortxlinks: false, oii: true, lootlabs: false },
  // ShrinkEarn primary; LootLabs fallback.
  shrinkearn_then_lootlabs: { shrinkearn: true, shortxlinks: false, oii: false, lootlabs: true },
  // oii.io only.
  oii_only: { shrinkearn: false, shortxlinks: false, oii: true, lootlabs: false },
  // ShrinkEarn only, no fallback.
  shrinkearn_only: { shrinkearn: true, shortxlinks: false, oii: false, lootlabs: false },
  shortxlinks: { shrinkearn: false, shortxlinks: true, oii: false, lootlabs: false },
}

export const metadata: Metadata = {
  title: "How to Unlock — Cookies Mo",
  description:
    "Step-by-step guides for unlocking your free account using LootLabs, ShrinkEarn, or oii.io. Watch the video tutorials or follow the written steps.",
}

const LOOTLABS_STEPS = [
  {
    icon: MousePointerClick,
    title: "Start the unlock step",
    body: "Make your selection, then tap the unlock button. A short list of quick tasks (offers) opens — this is what keeps the accounts free for everyone.",
  },
  {
    icon: CheckSquare,
    title: "Open every task",
    body: "Click through each task in the list. You don't need to finish anything inside them — just open each one so it registers.",
  },
  {
    icon: X,
    title: "Close the tabs",
    body: "Once you've opened the tasks, you can simply close those tabs and come back to this page. That's it on your end.",
  },
  {
    icon: Timer,
    title: "Wait about 60 seconds",
    body: "Keep this page open. After roughly 60 seconds your completion is confirmed and the Claim Reward button unlocks.",
  },
  {
    icon: Unlock,
    title: "Claim your account",
    body: "Tap Claim Reward and your account is checked live and revealed instantly — guaranteed to be a working one.",
  },
] as const

const OII_STEPS = [
  {
    icon: MousePointerClick,
    title: "Open the short link",
    body: "After you tap unlock you're sent to an oii.io page. Let it load fully — an ad step appears with a short counter.",
  },
  {
    icon: ShieldOff,
    title: "Turn off your ad blocker",
    body: "oii.io needs the ad to register. If you use Brave, tap the lion icon and lower Shields for the page — otherwise the step can loop and never advance past 1/2.",
  },
  {
    icon: CheckSquare,
    title: "Finish both ad steps",
    body: "Work through step 1/2 then 2/2, tapping continue after each counter finishes. Complete both so oii.io marks the visit as done.",
  },
  {
    icon: Timer,
    title: "Get sent back automatically",
    body: "After the last step oii.io redirects you straight back here. There's no 24-hour limit, so you can use it again right away.",
  },
  {
    icon: Unlock,
    title: "Claim your account",
    body: "Once you're returned, the Claim Reward button unlocks. Tap it and your account is checked live and revealed instantly.",
  },
] as const

// Placeholder video embed — the src is left empty so the admin can paste in a
// YouTube embed URL later. Renders a visible placeholder with instructions when
// no URL is provided.
function VideoEmbed({ src, label }: { src?: string; label: string }) {
  if (!src) {
    return (
      <div
        className="flex aspect-video w-full items-center justify-center border border-dashed border-border/30 bg-card"
        aria-label={`${label} video placeholder`}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <PlayCircle className="size-12 text-muted-foreground/40" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
            Video tutorial coming soon
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="aspect-video w-full overflow-hidden border border-border shadow-lg">
      <iframe src={src} title={label} allow="fullscreen" allowFullScreen className="size-full" />
    </div>
  )
}

function StepGrid({
  steps,
}: {
  steps: readonly { icon: React.FC<{ className?: string; "aria-hidden"?: boolean }>; title: string; body: string }[]
}) {
  return (
    <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {steps.map((step, i) => (
        <li key={step.title} className="flex flex-col gap-2 border border-border bg-background p-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center border border-border bg-primary font-mono text-xs font-semibold text-primary-foreground shadow-lg">
              {i + 1}
            </span>
            <step.icon className="size-4 text-foreground" aria-hidden />
          </div>
          <h3 className="text-sm font-semibold uppercase tracking-tight text-foreground">{step.title}</h3>
          <p className="text-xs font-medium leading-relaxed text-muted-foreground">{step.body}</p>
        </li>
      ))}
    </ol>
  )
}

  const LOOTLABS_VIDEO_SRC = "https://streamable.com/e/h1141e?loop=0"

// Left empty on purpose — paste the oii.io tutorial embed URL here later. Until
// then VideoEmbed renders the "Video tutorial coming soon" placeholder.
const OII_VIDEO_SRC = ""

export default async function UnlockGuidePage() {
  const [provider, passMode] = await Promise.all([getGatewayProvider(), isAccessPassMode()])
  const show = GUIDE_SECTIONS[provider]

  return (
    <main className="min-h-svh text-foreground">
      <SiteHeader cta="multi-service" />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Page header */}
        <div className="mb-10 flex flex-col gap-4">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-foreground ">
            <span className="size-2 bg-accent" aria-hidden />
            Step-by-step guide
          </span>
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl">
            How to unlock
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Follow the guide for the unlock method below — it&apos;s the exact one you&apos;ll see when you claim an
            account. It takes under a minute or two.
          </p>
          <div className="max-w-3xl">
            <VideoEmbed src="https://streamable.com/e/s921es?loop=0" label="Unlock tutorial" />
          </div>
        </div>

        <div className="flex flex-col gap-12">
          {/* ── oii.io section ──────────────────────────────────────────────── */}
          {show.oii && (
          <section aria-labelledby="oii-heading">
            <div className="mb-6 border-l-4 border-accent pl-4">
              <h2 id="oii-heading" className="text-2xl font-semibold uppercase tracking-tight text-foreground">
                oii.io unlock
              </h2>
              <p className="mt-1 text-sm font-medium leading-relaxed text-muted-foreground">
                A short link with a couple of quick ad steps. Finish both steps and you&apos;re returned automatically —
                unlike ShrinkEarn, there&apos;s no 24-hour limit, so you can use it as often as you like.
              </p>
            </div>

            {/* Ad-blocker notice — this is the #1 reason oii.io loops on step 1/2 */}
            <div className="mb-6 flex items-start gap-4 border border-border bg-primary px-5 py-4 shadow-lg">
              <span className="mt-0.5 shrink-0 font-mono text-lg font-semibold leading-none text-primary-foreground">
                !
              </span>
              <p className="text-sm font-medium leading-relaxed text-primary-foreground">
                <span className="font-semibold">Turn off your ad blocker for the oii.io page.</span> If the ad step keeps
                looping back to <span className="font-semibold">1/2</span> and never advances, an ad blocker (or Brave
                Shields) is stopping the ad from registering. Disable it for that page, reload, and both steps will
                complete normally.
              </p>
            </div>

            <div className="mb-6">
              <VideoEmbed src={OII_VIDEO_SRC} label="oii.io unlock tutorial" />
            </div>

            <StepGrid steps={OII_STEPS} />
          </section>
          )}

          {/* ── LootLabs section ────────────────────────────────────────────── */}
          {show.lootlabs && (
          <section aria-labelledby="lootlabs-heading">
            <div className="mb-6 border-l-4 border-primary pl-4">
              <h2 id="lootlabs-heading" className="text-2xl font-semibold uppercase tracking-tight text-foreground">
                LootLabs unlock
              </h2>
              <p className="mt-1 text-sm font-medium leading-relaxed text-muted-foreground">
                A task list opens — you only need to open each task, you don't need to finish the task. Wait about 60
                seconds and the Claim Reward button unlocks.
              </p>
            </div>

            {/* Default fallback notice */}
            <div className="mb-6 flex items-start gap-4 border border-border bg-card px-5 py-4 shadow-lg">
              <span className="mt-0.5 shrink-0 font-mono text-lg font-semibold leading-none text-foreground">i</span>
              <p className="text-sm font-medium leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground">This is the default unlock method</span> and is also
                used automatically when you have already claimed via ShrinkEarn within the last 24 hours. If you see a
                LootLabs task list instead of a short link, this is normal — just follow the steps below.
              </p>
            </div>

            <div className="mb-6">
              <VideoEmbed src={LOOTLABS_VIDEO_SRC} label="LootLabs unlock tutorial" />
            </div>

            <StepGrid steps={LOOTLABS_STEPS} />
          </section>
          )}
        </div>
      </div>

      <SiteFooter />
    </main>
  )
}
