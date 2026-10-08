import type { Metadata } from "next"
import { InfoPage, InfoCard } from "@/components/info-page"

// Pure static content page — prerender it as a CDN asset (no function per visit).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "Privacy & Security — Cookies Mo",
  description:
    "How Cookies Mo keeps your cookies safe: secure encrypted checks, nothing saved on the public tool, and strong protection when results are stored.",
}

export default function PrivacyPage() {
  return (
    <InfoPage
      badge="Privacy · Security"
      title="Privacy & security"
      intro="Your cookies are private, and we treat them that way. Here's exactly what happens to them and how they're protected during every check."
    >
      <InfoCard title="Nothing is saved on the public checker">
        <p>
          When you check cookies here, they're used for that one check and then thrown away. They're never added to a
          database or a log. Your results stay in your browser and disappear when you leave the page.
        </p>
      </InfoCard>

      <InfoCard title="Always sent over a secure connection">
        <p>
          Every check travels over a secure, encrypted connection straight to the streaming service — the same kind of
          protection your bank uses. Your cookie can't accidentally be sent in a way that someone could read.
        </p>
        <p>
          When checking big lists, we route requests through different connection points so they go through smoothly.
          Even then, the connection stays sealed end-to-end, so those relay points can never see your cookie.
        </p>
      </InfoCard>

      <InfoCard title="Protected from sketchy middlemen">
        <p>
          We only trust a result if it genuinely comes from the real streaming service. If anything tries to quietly
          send your check somewhere else, we throw that result away and try again rather than risk your cookie.
        </p>
      </InfoCard>

      <InfoCard title="Strongly protected when saved">
        <p>
          In the rare cases where results are saved on purpose (inside our private admin tool), the cookies are
          scrambled with strong encryption first. Readable cookies are never stored.
        </p>
      </InfoCard>

      <InfoCard title="Free account generators">
        <p>
          Accounts handed out by the free generators are verified live before you ever see them, and each one can only
          be claimed once. We don't ask for a password, payment, or any personal details to claim — just the quick
          unlock step.
        </p>
        <p>
          We apply simple per-person limits (Netflix 3 per hour, Prime and Crunchyroll 2 per day) purely to keep things
          fair and prevent abuse — not to track you.
        </p>
      </InfoCard>

      <InfoCard title="Please use it responsibly">
        <p>
          Cookies Mo is meant for checking accounts you own or are allowed to test. It's built as a safety and learning
          tool — please use it that way.
        </p>
      </InfoCard>
    </InfoPage>
  )
}
