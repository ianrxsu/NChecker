import { MousePointerClick, CheckSquare, X, Timer, Unlock } from "lucide-react"

// Inline "how to unlock" walkthrough shown on every account-generator page. It
// sets expectations before the user starts the LootLabs step: complete the tasks,
// they can simply open each one and close the tab, then wait ~60s for the Claim
// Reward button to unlock. Purely presentational (no state) so it stays static.
const STEPS = [
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

export function UnlockTutorial() {
  return (
    <section aria-label="How to unlock your account" className="mb-8 border border-border bg-card p-5 shadow-lg sm:p-6">
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="text-lg font-semibold uppercase tracking-tight text-foreground">How to unlock — quick guide</h2>
        <p className="text-sm font-medium leading-relaxed text-muted-foreground">
          It only takes a minute. Open the tasks, close the tabs, and wait about{" "}
          <span className="font-semibold text-foreground">60 seconds</span> for the Claim Reward button to unlock.
        </p>
      </div>

      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {STEPS.map((step, i) => (
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
    </section>
  )
}
