import type { Metadata } from "next"
import { InfoPage, InfoCard } from "@/components/info-page"

// Pure static content page — prerender it as a CDN asset (no function per visit).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "About — Cookies Mo",
  description:
    "What Cookies Mo is and everything it does: instant Netflix, Amazon Prime, and Crunchyroll cookie checking for one or thousands at once, plus free verified account generators — all explained in plain language.",
}

// Plain-language overview of the whole product: branding, what each feature does,
// and how it stays safe. Written for normal users, not power users.
export default function AboutPage() {
  return (
    <InfoPage
      badge="About Cookies Mo"
      title="What Cookies Mo is"
      intro="Cookies Mo is the simplest way to find out whether your streaming cookies still work — and to claim a free account when you need one. No setup, no jargon, no cleanup. Here's everything it does, in plain language."
    >
      <InfoCard title="The short version">
        <p>
          A <span className="font-semibold text-foreground">cookie</span> is the little bit of saved login that keeps
          you signed in to a website. Cookies Mo takes those cookies and tells you one simple thing:{" "}
          <span className="font-semibold text-foreground">does this still work, or has it expired?</span> You can check
          a single cookie or thousands at once, and you get a clear answer in seconds.
        </p>
        <p>
          On top of that, you can claim a free, working account for Netflix, Amazon Prime, or Crunchyroll — each one
          checked live before it reaches you.
        </p>
      </InfoCard>

      <InfoCard title="Check Netflix, Prime & Crunchyroll">
        <p>
          There's a dedicated checker for each service: <span className="font-semibold text-foreground">Netflix</span>,{" "}
          <span className="font-semibold text-foreground">Amazon Prime Video</span>, and{" "}
          <span className="font-semibold text-foreground">Crunchyroll</span>. Each one tests your cookie against the
          real service, so a result is never a guess. For working accounts, you also see the details we can read — like
          the plan, country, membership status, and profiles.
        </p>
      </InfoCard>

      <InfoCard title="One cookie or thousands">
        <p>
          Use <span className="font-semibold text-foreground">Single</span> mode to test one cookie and see its full
          account details, or <span className="font-semibold text-foreground">Bulk</span> mode to paste in an entire
          list. Bulk mode removes duplicates automatically, shows a live progress count, stays fast no matter how many
          you add, and lets you re-check all the expired ones with a single click.
        </p>
      </InfoCard>

      <InfoCard title="Any format, no cleanup">
        <p>
          However your cookies were saved — a single line, a{" "}
          <span className="font-semibold text-foreground">cookies.txt</span> file, or a JSON export — you can paste them
          straight in. You can even upload whole files and folders, including{" "}
          <span className="font-semibold text-foreground">.zip</span> and{" "}
          <span className="font-semibold text-foreground">.rar</span> archives, and we'll read every cookie inside.
          There's nothing to tidy up first.
        </p>
      </InfoCard>

      <InfoCard title="Free account generators">
        <p>
          Need an account instead of a checker? Cookies Mo has free generators for{" "}
          <span className="font-semibold text-foreground">Netflix</span>,{" "}
          <span className="font-semibold text-foreground">Amazon Prime</span>, and{" "}
          <span className="font-semibold text-foreground">Crunchyroll</span>. Make your selection where there is one,
          complete one quick step to unlock, and the account is verified live the moment it's revealed — so you only
          ever get one that genuinely works.
        </p>
        <p>
          To keep things fair, claims are limited per person: Netflix allows up to 3 per hour, while Prime and
          Crunchyroll allow 2 per day each. Crunchyroll stock is limited, so there you simply get a random working
          premium account.
        </p>
      </InfoCard>

      <InfoCard title="Instant, clear results">
        <p>
          Everything is built to be fast and easy to read. Working cookies are clearly marked and come with their
          account details; expired ones are flagged so you can ignore or re-check them. When you're done, you can filter
          your list and download the results in the format you prefer.
        </p>
      </InfoCard>

      <InfoCard title="Private and safe by design">
        <p>
          When you use the public checker, your cookies are tested once and then thrown away — never saved, never
          logged. Every check travels over a secure, encrypted connection straight to the real service, and we refuse
          any result that doesn't genuinely come from it.
        </p>
        <p>
          Cookies Mo is meant for checking accounts you own or are allowed to test. It's built as a safety and learning
          tool — please use it that way.
        </p>
      </InfoCard>
    </InfoPage>
  )
}
