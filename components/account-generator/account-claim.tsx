"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ShieldCheck, AlertTriangle } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { ResultReport } from "@/components/checker/result-report"
import type { ClaimResult } from "@/lib/reward-claim"

type ClaimService = "netflix" | "prime" | "crunchyroll"

// Human label for the service being unlocked, used in the verifying copy so the
// screen never says "Netflix" while a Prime/Crunchyroll account is being claimed.
const SERVICE_LABEL: Record<ClaimService, string> = {
  netflix: "Netflix",
  prime: "Amazon Prime",
  crunchyroll: "Crunchyroll",
}

// Calls the STABLE API route (not a Server Action). A route URL never changes
// across deploys, so a poll can't hit a stale action ID and 500. A non-OK HTTP
// response is treated as "pending" so we just keep polling. The `service` is sent
// so the server only ever consumes a token bound to THIS generator's pool.
async function claimReward(tokens: string[], service: ClaimService): Promise<ClaimResult> {
  const res = await fetch("/api/reward/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokens, service }),
    cache: "no-store",
  })
  if (!res.ok) return { ok: false, error: "pending" }
  return (await res.json()) as ClaimResult
}

type State = { phase: "verifying"; confirming: boolean } | { phase: "done"; result: ClaimResult }

// LootLabs' server-to-server completion postback can lag SIGNIFICANTLY — in
// practice anywhere from a couple seconds to several MINUTES after the user
// returns. We must out-wait that lag: the cookie token reliably points at the
// right session, so once the postback unlocks it, a poll will consume it. Poll
// every 3s for up to ~4 minutes before giving up. Even if the user gives up, the
// token cookie persists, so simply re-opening /reward-callback later still works.
const RETRY_DELAY_MS = 3000
const MAX_ATTEMPTS = 80 // ~4 minutes

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Turns a window-reset timestamp into a friendly "in about 2 hours" / "in 45
// minutes" hint for the rate-limit message.
// Friendly "in about 23 hours" hint for when the freshly-earned 24h access pass ends.
// Clamp to the 24h ceiling: the pass is minted server-side as now+24h, so any larger
// value is purely a slow CLIENT clock inflating an absolute-epoch diff (the same cause
// as the "25:48" countdown bug). Clamping only trims that over-count.
function formatExpiry(expiresAt: number): string {
  const diffMs = Math.min(24 * 60 * 60 * 1000, expiresAt - Date.now())
  if (diffMs <= 0) return "shortly"
  const hours = Math.round(diffMs / 3_600_000)
  if (hours >= 1) return `in about ${hours} hour${hours === 1 ? "" : "s"}`
  const minutes = Math.max(1, Math.round(diffMs / 60_000))
  return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`
}

function formatResetHint(resetMs: number): string {
  const diffMs = resetMs - Date.now()
  if (diffMs <= 0) return "shortly"
  const minutes = Math.ceil(diffMs / 60000)
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.ceil(minutes / 60)
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`
}

export function AccountClaim({
  tokens,
  backHref = "/account-generator",
  service = "netflix",
  hideCookies = false,
}: {
  tokens: string[]
  // Where "Try again" / "Claim another" return to — the matching service's
  // generator. The claim itself is service-agnostic (the server derives the
  // service from the token's session).
  backHref?: string
  // Which service this callback is unlocking. Drives the verifying copy and is
  // sent to the claim API so a stale token from another service's pool can never
  // be consumed here.
  service?: ClaimService
  // When true, all cookie copy actions are hidden from the result — only Direct
  // Auth Links remain. Controlled by the admin "Netflix generator links only" toggle.
  hideCookies?: boolean
}) {
  const [state, setState] = useState<State>({ phase: "verifying", confirming: false })
  // Guard against React StrictMode double-invoking the effect in dev, which would
  // fire two claims. The endpoint is idempotent per token, but this keeps the UI to
  // a single in-flight request.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    // Strip the ?r= token from the address bar so a manual refresh/share can't
    // replay it (the server is already single-use, this is just hygiene).
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname)
    }

    let cancelled = false

    async function run() {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const result = await claimReward(tokens, service)
          if (cancelled) return
          // Still waiting on the LootLabs postback — keep polling.
          if (!result.ok && result.error === "pending") {
            setState({ phase: "verifying", confirming: true })
            await wait(RETRY_DELAY_MS)
            continue
          }
          setState({ phase: "done", result })
          return
        } catch {
          if (cancelled) return
          // A thrown error is ALWAYS treated as transient — never as a hard
          // "invalid". The session is single-use server-side, so re-polling is safe
          // and can't double-grant. This guarantees a server/DB hiccup can never
          // show the misleading "link already used" message.
          setState({ phase: "verifying", confirming: true })
          await wait(RETRY_DELAY_MS)
        }
      }
      // Exhausted the window without confirmation → surface the pending error so
      // the user knows the postback hasn't arrived yet (they can keep waiting).
      if (!cancelled) setState({ phase: "done", result: { ok: false, error: "pending" } })
    }

    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.join(",")])

  if (state.phase === "verifying") {
    return (
      <div className="flex flex-col items-center gap-5 border border-border bg-card p-10 text-center shadow-lg">
        <Spinner className="size-10" thickness={4} />
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold uppercase tracking-widest text-foreground">
            {state.confirming ? "Confirming gateway" : "Verifying account status"}
          </p>
          <p className="text-sm font-medium text-muted-foreground">
            {state.confirming
              ? "Waiting for LootLabs to confirm your completion. This can take a minute or two — please keep this page open…"
              : `Checking a live account against ${SERVICE_LABEL[service]}. This only takes a moment…`}
          </p>
        </div>
      </div>
    )
  }

  if (!state.result.ok) {
    // "pending" means the gateway completion postback just hasn't reached us YET
    // (LootLabs can take a few minutes). The token is still valid, so the action is
    // to KEEP WAITING / re-check the same token — NOT to start a brand-new gateway.
    const r = state.result
    const isPending = r.error === "pending"
    const isRateLimited = r.error === "rate_limited"
    const title = isPending ? "Almost there" : isRateLimited ? "Daily limit reached" : "Unlock failed"
    let msg: string
    if (r.error === "empty") {
      msg = "No live accounts are available for your selection right now. Try a different plan or country."
    } else if (r.error === "rate_limited") {
      msg = `You've reached the free-account limit for this service (${r.label}). Please come back ${formatResetHint(r.resetMs)} to claim another.`
    } else if (r.error === "pending") {
      msg =
        "We haven't received confirmation from LootLabs yet — this can take a few minutes after you finish. Keep this page open, or tap below to check again. As long as you completed every step, your account will unlock."
    } else {
      msg = "This link is invalid or has already been used. Each unlock works only once."
    }
    return (
      <div className="flex flex-col items-center gap-5 border border-destructive/50 bg-card p-10 text-center shadow-[6px_6px_0px_0px_var(--destructive)]">
        <div className="flex size-14 items-center justify-center border border-border bg-destructive text-background">
          <AlertTriangle className="size-7" aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold uppercase tracking-widest text-foreground">{title}</p>
          <p className="max-w-sm text-sm font-medium leading-relaxed text-muted-foreground">{msg}</p>
        </div>
        {isPending ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 border border-border bg-primary px-5 py-3 text-sm font-semibold uppercase tracking-widest text-primary-foreground shadow-lg transition-all "
          >
            Check again
          </button>
        ) : (
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 border border-border bg-primary px-5 py-3 text-sm font-semibold uppercase tracking-widest text-primary-foreground shadow-lg transition-all "
          >
            {isRateLimited ? "Back to generator" : "Try again"}
          </Link>
        )}
      </div>
    )
  }

  // ACCESS PASS unlock: the gateway completion earned a 24h pass and NO account.
  if ("pass" in state.result) {
    const { expiresAt } = state.result.pass
    const isNetflixChecker = service === "netflix"
    return (
      <div className="flex flex-col items-center gap-5 border border-border bg-card p-10 text-center shadow-lg">
        <div className="flex size-14 items-center justify-center border border-border bg-success text-success-foreground">
          <ShieldCheck className="size-7" aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold uppercase tracking-widest text-foreground">
            {isNetflixChecker ? "24-hour checker access unlocked" : "24-hour access unlocked"}
          </p>
          <p className="max-w-sm text-sm font-medium leading-relaxed text-muted-foreground">
            {isNetflixChecker
              ? "You can now check Netflix cookies with no extra unlock steps for the next 24 hours. Your access ends "
              : "You can now generate accounts with no extra steps for the next 24 hours. Your access ends "}
            <span className="font-semibold text-foreground">{formatExpiry(expiresAt)}</span>.
          </p>
        </div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 border border-border bg-primary px-5 py-3 text-sm font-semibold uppercase tracking-widest text-primary-foreground shadow-lg transition-all"
        >
          {isNetflixChecker ? "Open checker" : "Start generating"}
        </Link>
      </div>
    )
  }

  const { account } = state.result
  return (
    <div className="flex flex-col gap-5">
      {/* Success banner */}
      <div className="flex items-center gap-3 border border-border bg-success p-4 text-success-foreground ">
        <ShieldCheck className="size-6 shrink-0" aria-hidden />
        <div className="flex flex-col">
          <span className="text-base font-semibold uppercase tracking-widest">Account unlocked</span>
          <span className="text-xs font-bold">Verified alive moments ago — full details below.</span>
        </div>
      </div>

      {/* Full account details + direct links, identical to the single checker.
 Pass the service so Prime/Crunchyroll render the Name hero (not "Email"),
 show all profiles, and export cookies with the correct domain. */}
      <ResultReport cookie={account.cookie} result={account.result} service={service} hideCookies={hideCookies} />

      <Link
        href={backHref}
        className="inline-flex w-fit items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Claim another
      </Link>
    </div>
  )
}
