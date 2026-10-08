import type { Metadata } from "next"
import { InfoPage, InfoCard } from "@/components/info-page"

// Pure static content page — prerender it as a CDN asset (no function per visit).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "How It Works — Cookies Mo",
  description:
    "How Cookies Mo checks your Netflix, Prime, and Crunchyroll cookies: paste them in, we test each one safely, and you get a clear working-or-expired answer.",
}

const STEPS = [
  {
    n: "01",
    title: "Paste your cookies",
    body: "Add a single cookie or thousands at once. It doesn't matter how they were saved or copied — we recognize every common format automatically, so there's nothing to clean up first.",
  },
  {
    n: "02",
    title: "We tidy up the list",
    body: "Any duplicates are removed so you never waste a check on the same cookie twice. Whatever's left is lined up and checked, with a live progress count as it goes.",
  },
  {
    n: "03",
    title: "Each cookie is checked safely",
    body: "Every cookie is tested against the real service over a secure, encrypted connection. For big lists we route checks through different connection points so they go through smoothly — and your cookie stays private the whole time.",
  },
  {
    n: "04",
    title: "You get a clear answer",
    body: "Working cookies come with the account details we can read — like plan, country, and membership status. Expired ones are flagged. You can re-check the expired ones, filter the list, and download your results.",
  },
]

export default function HowItWorksPage() {
  return (
    <InfoPage
      badge="Check · Sort · Understand"
      title="How the checker works"
      intro="Cookies Mo turns a messy pile of cookies into a clean list of what still works — without saving anything. Here's the whole process, start to finish."
    >
      {STEPS.map((step) => (
        <InfoCard
          key={step.n}
          title={
            <span className="flex items-center gap-3">
              <span className="inline-flex size-9 items-center justify-center border border-border bg-primary font-mono text-sm text-primary-foreground ">
                {step.n}
              </span>
              {step.title}
            </span>
          }
        >
          <p>{step.body}</p>
        </InfoCard>
      ))}

      <InfoCard title="Single vs. Bulk">
        <p>
          <span className="font-semibold text-foreground">Single check</span> is the quickest way to test one cookie and
          see the full account details. <span className="font-semibold text-foreground">Bulk check</span> is built for
          long lists — it removes duplicates, stays fast no matter how many you add, shows live totals, and lets you
          re-check all the expired ones with a single click.
        </p>
        <p>Whichever mode you're in is kept if you refresh the page, so you never lose your place.</p>
      </InfoCard>

      <InfoCard title="Claiming a free account">
        <p>
          Besides the checkers, Cookies Mo has free account generators for{" "}
          <span className="font-semibold text-foreground">Netflix</span>,{" "}
          <span className="font-semibold text-foreground">Amazon Prime</span>, and{" "}
          <span className="font-semibold text-foreground">Crunchyroll</span>. Pick what you want (where there's a
          choice), complete one quick step to unlock, and the account is checked live the instant it's revealed — so you
          only ever receive one that genuinely works.
        </p>
        <p>
          To keep it fair for everyone, claims are limited per person: Netflix allows up to 3 per hour, while Prime and
          Crunchyroll allow 2 per day each.
        </p>
      </InfoCard>
    </InfoPage>
  )
}
