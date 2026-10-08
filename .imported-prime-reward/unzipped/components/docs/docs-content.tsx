import type { ReactNode } from "react"
import type { DocSection } from "@/components/docs/docs-toc"

// Ordered list of doc sections. Shared with the TOC so navigation and content
// never drift apart — add a section here and it appears in both.
export const DOC_SECTIONS: DocSection[] = [
  { id: "overview", title: "Overview" },
  { id: "checkers", title: "The Cookie Checkers" },
  { id: "formats", title: "Supported Formats" },
  { id: "verification", title: "How Verification Works" },
  { id: "generators", title: "Account Generators" },
  { id: "gateway", title: "The Unlock Gateway" },
  { id: "distribution", title: "Random Distribution" },
  { id: "limits", title: "Rate Limits & Fairness" },
  { id: "security", title: "Security & Privacy" },
  { id: "admin", title: "Admin Panel" },
]

// ── Small presentational primitives (brutalist card system) ──────────────────

function Section({ id, title, kicker, children }: { id: string; title: string; kicker: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border border-border bg-card p-5 shadow-lg sm:p-6">
      <span className="mb-2 inline-block font-mono text-[11px] font-semibold uppercase tracking-widest text-accent">
        {kicker}
      </span>
      <h2 className="mb-4 text-xl font-semibold uppercase tracking-tight text-foreground sm:text-2xl">{title}</h2>
      <div className="flex flex-col gap-3 text-sm font-medium leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}

// Emphasized inline term.
function T({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-foreground">{children}</span>
}

// Numbered step row.
function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center border border-border bg-primary font-mono text-xs font-semibold text-primary-foreground shadow-lg">
        {n}
      </span>
      <div className="flex flex-col gap-1">
        <span className="font-semibold uppercase tracking-tight text-foreground">{title}</span>
        <span>{children}</span>
      </div>
    </div>
  )
}

// Highlighted note/callout.
function Callout({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  const accent = tone === "warn" ? "bg-destructive" : "bg-accent"
  return (
    <div className="flex gap-3 border border-border bg-background p-3">
      <span className={`mt-1 size-2 shrink-0 ${accent}`} aria-hidden />
      <p className="text-[13px] leading-relaxed">{children}</p>
    </div>
  )
}

// A compact definition-style row for feature grids.
function Def({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="border border-border bg-background p-3">
      <dt className="mb-1 text-xs font-semibold uppercase tracking-widest text-foreground">{term}</dt>
      <dd className="text-[13px] leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  )
}

// ── Content ──────────────────────────────────────────────────────────────────

export function DocsContent() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Section id="overview" kicker="01 · Start here" title="Overview">
        <p>
          <T>Cookies Mo</T> does two jobs. First, it&apos;s a <T>cookie checker</T> — paste a browser session cookie for
          Netflix, Amazon Prime, or Crunchyroll and it tells you whether that session still works, along with the
          account details it can read. Second, it&apos;s a set of <T>free account generators</T> for the same three
          services: complete one quick unlock step and receive a working account that&apos;s verified live the moment
          it&apos;s revealed.
        </p>
        <p>
          Everything runs <T>server-side</T>. Cookies you paste are checked over an encrypted connection and are never
          stored. The pool of accounts behind the generators is never exposed to the browser — the server picks one,
          confirms it&apos;s alive, and returns only that single result.
        </p>
        <dl className="mt-1 grid gap-3 sm:grid-cols-3">
          <Def term="Checkers">Netflix, Prime, Crunchyroll — single or bulk.</Def>
          <Def term="Generators">One verified account per claim, per service.</Def>
          <Def term="Storage">Pasted cookies are never saved. Nothing to clean up.</Def>
        </dl>
      </Section>

      <Section id="checkers" kicker="02 · Checking" title="The Cookie Checkers">
        <p>Each service has its own checker with two modes:</p>
        <div className="flex flex-col gap-3">
          <Step n="S" title="Single check">
            The fastest way to test one cookie. It returns the <T>full account report</T> — plan, country, member-since,
            billing, profiles, and (for Netflix) one-click auto-login links for PC, Mobile, and TV when the direct-link
            toggle is on.
          </Step>
          <Step n="B" title="Bulk check">
            Built for long lists. Paste anything from a handful to thousands. Duplicates are removed automatically so
            you never spend a check on the same cookie twice, a live progress count ticks as it runs, and you can filter
            results, re-check all the expired ones with one click, and export what you keep.
          </Step>
        </div>
        <p>
          Your chosen mode and results survive a page refresh, so you never lose your place. Each result is labeled
          plainly as <T>alive</T> or <T>expired</T>, with the reason where one is available.
        </p>
      </Section>

      <Section id="formats" kicker="03 · Input" title="Supported Formats">
        <p>
          It doesn&apos;t matter how a cookie was saved or copied — the app recognizes every common shape and normalizes
          it before checking, so there&apos;s nothing to clean up first:
        </p>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Def term="JSON">Cookie-Editor / EditThisCookie array exports.</Def>
          <Def term="Netscape">
            The classic <span className="font-mono">cookies.txt</span> tab-separated format.
          </Def>
          <Def term="Header string">
            A raw <span className="font-mono">name=value; name2=value2</span> line.
          </Def>
        </dl>
        <Callout>
          Normalization is <T>service-aware</T>. A Prime cookie keeps its Amazon auth tokens (
          <span className="font-mono">at-main-av</span>, <span className="font-mono">x-main-av</span>,{" "}
          <span className="font-mono">session-token</span>); a Netflix cookie keeps its Netflix session. Preparing a
          cookie with the wrong service would strip the tokens that prove you&apos;re logged in — which is why the
          checker always normalizes with the exact service it&apos;s about to test.
        </Callout>
      </Section>

      <Section id="verification" kicker="04 · Under the hood" title="How Verification Works">
        <p>
          A cookie is verified by making a real, authenticated request to the service and reading back the account state
          — never by guessing from the cookie&apos;s shape. There are two ways that request is routed:
        </p>
        <div className="flex flex-col gap-3">
          <Step n="1" title="Direct (single checks & reward claims)">
            One cookie checked from the server directly. A single low-volume request can&apos;t trip a service&apos;s
            rate limits, and going direct avoids proxy latency and the chance of a flaky exit IP producing a false
            result.
          </Step>
          <Step n="2" title="Through the proxy pool (bulk checks)">
            Large lists are spread across many rotating connection points so they go through smoothly without being
            throttled. A check that&apos;s blocked or times out on one connection is retried on another before any
            verdict is trusted.
          </Step>
        </div>
        <p>
          Some signals need extra care. For <T>Netflix</T>, the one-click auto-login links are minted from a token host
          that is heavily bot-blocked from datacenter IPs; when a direct mint is refused, the app re-mints through the
          live proxy pool so the links are reliably present. For <T>Amazon Prime</T>, a session opened from a distant IP
          can be bounced to a sign-in page (which looks like &quot;expired&quot;), so a direct dead verdict is
          re-checked through a proxy before it&apos;s believed — this prevents a valid foreign account from being
          falsely marked dead.
        </p>
        <Callout tone="warn">
          Verdicts are conservative on purpose. A cookie is only called <T>expired</T> when the service itself says the
          session is logged out or the plan is inactive. Anything ambiguous — a timeout, a block, a bot challenge — is
          reported as inconclusive and never treated as a hard failure.
        </Callout>
        <p>
          Membership status is read where the service exposes it. A Netflix account whose payment failed (an
          &quot;on-hold&quot; membership) still authenticates, so it&apos;s counted as a live session — but it&apos;s
          flagged so it&apos;s never handed out by a generator, since it can&apos;t actually stream.
        </p>
      </Section>

      <Section id="generators" kicker="05 · Free accounts" title="Account Generators">
        <p>There&apos;s a generator for Netflix, Amazon Prime, and Crunchyroll. The flow is the same for each:</p>
        <div className="flex flex-col gap-3">
          <Step n="1" title="Choose what you want">
            Where there&apos;s a choice (for example a plan or country), you pick it. The selector only offers
            combinations the pool can actually fulfill and shows how many accounts back each option.
          </Step>
          <Step n="2" title="Complete one unlock step">
            You&apos;re sent through a short link gateway. This is what keeps the service free to run.
          </Step>
          <Step n="3" title="Get a verified account">
            The instant your account is revealed, it&apos;s checked live. You only ever receive one that genuinely works
            at that moment — dead ones are skipped automatically.
          </Step>
        </div>
        <p>
          Because verification happens at reveal time, an account that quietly expired while sitting in the pool never
          reaches you — the server skips past it to a live one (and cleans the dead one up, covered below).
        </p>
      </Section>

      <Section id="gateway" kicker="06 · Unlock" title="The Unlock Gateway">
        <p>
          Unlocking is protected by a <T>server-to-server postback</T>, not just a browser redirect. This is what stops
          anyone from skipping the step and jumping straight to the reward page. Here&apos;s the exact round trip:
        </p>
        <div className="flex flex-col gap-3">
          <Step n="1" title="Mint a session token">
            When you start, the server creates a single-use token bound to your chosen plan/service and marks it{" "}
            <T>pending</T>. The token is stored in a first-party, HTTP-only cookie so it survives the round trip even if
            the gateway strips the query string.
          </Step>
          <Step n="2" title="Complete the gateway">
            You&apos;re redirected into the link gateway with the token attached. Only genuine completion triggers the
            next step.
          </Step>
          <Step n="3" title="Server confirms completion">
            The gateway calls a secret postback URL on our server, echoing the token back. That call — verified with a
            constant-time secret check and protected against replays — is the <T>only</T> thing that flips the session
            to unlocked.
          </Step>
          <Step n="4" title="Reward is released">
            Back on our domain, the reward page refuses to distribute until it sees the token unlocked. Once it does,
            the account is verified live and revealed.
          </Step>
        </div>
        <Callout tone="warn">
          The postback <T>fails closed</T>: if the shared secret isn&apos;t configured, no completion is ever accepted,
          so a misconfiguration can never accidentally unlock sessions for free.
        </Callout>
      </Section>

      <Section id="distribution" kicker="07 · Fairness" title="Random Distribution">
        <p>
          When you claim, the server does <T>not</T> hand out &quot;the first account in the table.&quot; Selection is
          fully randomized and spread across users. This is identical for every service:
        </p>
        <div className="flex flex-col gap-3">
          <Step n="1" title="Shuffle everything">
            The eligible pool is shuffled with a Fisher–Yates shuffle, so ordering in the database has no bearing on
            what you get.
          </Step>
          <Step n="2" title="Prefer your exact match, still random">
            Accounts matching your chosen plan and country are tried first, then everything else as a fallback — but
            each tier is independently shuffled, so selection stays random <em>within</em> the group.
          </Step>
          <Step n="3" title="Spread across users">
            Accounts handed to anyone in the last 30 minutes are pushed to the back of the line (remembered in shared
            storage across all servers), so two people claiming at once don&apos;t land on the same account.
            They&apos;re deprioritized, never excluded, so even a tiny pool keeps working.
          </Step>
          <Step n="4" title="Verify, skip, and clean up">
            Candidates are verified live in small concurrent waves. The first one confirmed alive (in shuffled order) is
            returned. Any candidate confirmed <T>authoritatively dead</T> is purged from the pool in the same pass.
          </Step>
        </div>
        <Callout>
          <T>False-positive safety:</T> an account is only ever deleted when verification is authoritative (the service
          says logged-out / expired). A transient failure — proxy block, timeout, rate-limit, bot challenge — is treated
          as &quot;unknown&quot;: skipped for that claim but never deleted, so a flaky connection can&apos;t wipe a
          still-valid account. You&apos;re also never shown an account you&apos;ve already received.
        </Callout>
      </Section>

      <Section id="limits" kicker="08 · Anti-abuse" title="Rate Limits & Fairness">
        <p>
          To keep the generators fair for everyone, claims are capped <T>per person</T> — enforced on both IP address
          and a signed device id, and only counted when an account is genuinely handed out (saved or claimed accounts on
          your device don&apos;t burn your allowance):
        </p>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Def term="Netflix">Up to 3 claims per hour.</Def>
          <Def term="Prime">Up to 2 claims per day.</Def>
          <Def term="Crunchyroll">Up to 2 claims per day.</Def>
        </dl>
        <p>
          The cap is checked <T>before</T> the gateway opens, so if you&apos;re over the limit the form shows a live
          countdown instead of sending you into an unlock step you can&apos;t redeem. Separately, the bulk checker is
          rate-limited to protect the upstream services, not your wallet.
        </p>
      </Section>

      <Section id="security" kicker="09 · Trust" title="Security & Privacy">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Def term="Nothing pasted is stored">
            Cookies you check are processed in memory over an encrypted connection and discarded. There&apos;s nothing
            to clean up afterward.
          </Def>
          <Def term="Pool stays server-side">
            The accounts behind the generators never touch the browser. The server selects, verifies, and returns
            exactly one result.
          </Def>
          <Def term="Single-use tokens">
            Every unlock session is a one-time token. Replays and already-consumed completions are rejected.
          </Def>
          <Def term="Constant-time secret checks">
            The postback secret is compared in constant time so the endpoint can&apos;t be probed by timing, and it
            fails closed when unset.
          </Def>
        </dl>
        <Callout>
          Cookies Mo is for checking accounts you own or have permission to test. It never phishes, and it never asks
          for your password — a session cookie is all a checker needs.
        </Callout>
      </Section>

      <Section id="admin" kicker="10 · Operations" title="Admin Panel">
        <p>
          Behind authentication, an admin panel powers day-to-day operations: running the Netflix, Prime, and
          Crunchyroll checkers with alive sessions saved to a private database; browsing and managing each
          service&apos;s saved pool; extracting cookies; and viewing analytics, activity, and system status.
        </p>
        <p>
          The saved pools are exactly what the generators distribute from. A background recheck keeps them honest by
          re-verifying stored accounts and removing ones that have authoritatively died — so the pool a claim draws from
          stays as live as possible.
        </p>
      </Section>
    </div>
  )
}
