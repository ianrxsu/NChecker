import type { Metadata } from "next"
import { InfoPage, InfoCard } from "@/components/info-page"

// Pure static content page — prerender it as a CDN asset (no function per visit).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "FAQ — Cookies Mo",
  description:
    "Common questions about Cookies Mo: how accurate it is, whether your cookies are safe, list sizes, re-checking, and downloads.",
}

const FAQS = [
  {
    q: "Are my cookies saved anywhere?",
    a: "No. When you use the public checker, your cookies are tested right then and the results show only in your browser. Nothing is written down or kept once you leave the page.",
  },
  {
    q: "Could someone intercept my cookies during a check?",
    a: "No. Every check happens over a secure, encrypted connection straight to the streaming service, so your cookie can't be read along the way. We also refuse to send it anywhere other than the real service's website.",
  },
  {
    q: 'What does "working" actually mean?',
    a: "It means the cookie successfully opened the account, so it's still valid right now. When it does, we also show you the account details we can read — like the plan, country, and membership status.",
  },
  {
    q: "Why are some cookies marked as an error instead of expired?",
    a: "An error means we couldn't get a clear answer that time — usually a temporary connection hiccup or the service being busy. It does NOT mean the cookie is dead, so it's worth trying again.",
  },
  {
    q: 'What does "Recheck expired" do?',
    a: "It tests every expired cookie again, fresh, in case one started working or an earlier check was just a fluke. Any that come back working are updated in your list right away.",
  },
  {
    q: "Is there a limit to how many I can check at once?",
    a: "Not really. Whether you check a hundred or a hundred thousand, the page stays fast and responsive. Duplicates are skipped automatically so you don't waste time on the same cookie twice.",
  },
  {
    q: "How do the free account generators work?",
    a: "Pick a service (Netflix, Prime, or Crunchyroll), make your selection where there is one, and complete one quick step to unlock. We then pull an account, check it live, and reveal it only if it's actually working — so you never get a dead one.",
  },
  {
    q: "Is there a limit on how many free accounts I can claim?",
    a: "Yes, to keep it fair for everyone. Netflix allows up to 3 claims per hour, and Prime and Crunchyroll allow 2 per day each. If you hit the limit, just come back after it resets.",
  },
  {
    q: "Why does claiming take about a minute?",
    a: "After you finish the unlock step, we wait for confirmation before handing over an account. This usually lands within about 60 seconds. Keep the page open and the Claim Reward button unlocks as soon as it's confirmed.",
  },
]

export default function FaqPage() {
  return (
    <InfoPage
      badge="Questions · Answers"
      title="Frequently asked questions"
      intro="Quick answers to the things people ask most — how the checker works, what happens to your cookies, and how it keeps them safe."
    >
      {FAQS.map((faq) => (
        <InfoCard key={faq.q} title={faq.q}>
          <p>{faq.a}</p>
        </InfoCard>
      ))}
    </InfoPage>
  )
}
