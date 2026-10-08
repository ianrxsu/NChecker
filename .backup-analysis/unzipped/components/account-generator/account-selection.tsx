"use client"

import { useActionState, useCallback, useEffect, useMemo, useState } from "react"
import { useFormStatus } from "react-dom"
import { Check, Lock, Gift, Globe, ExternalLink, TimerReset, Ticket } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { SelectDropdown, type SelectOption } from "@/components/ui/select-dropdown"
import { countryName } from "@/lib/country-names"
import { startGeneration, type StartGenerationState } from "@/app/account-generator/actions"
import { cn } from "@/lib/utils"

// `count` is an AVAILABILITY FLAG (1 = available, 0 = none), NOT a real stock number.
// The server clamps it in getPoolOptions so exact stock never reaches the browser.
// Summing flags still yields correct availability (`> 0`) for any plan/country filter.
type Combo = { plan: string; country: string; count: number }

// Builds the visible stock label. GATING always uses the live availability flag
// (`current`), so buttons never wrongly enable/disable. The number shown is the
// REAL count from ~1 hour ago (`delayed`): when the item is currently in stock we
// surface that delayed number ("N available"); if no delayed data has accrued yet
// (delayed === 0) we fall back to the plain "Available" label, and anything with no
// live stock shows "Unavailable".
function stockLabel(current: number, delayed: number): string {
  if (current === 0) return "Unavailable"
  if (delayed > 0) return `${delayed.toLocaleString()} available`
  return "Available"
}

// A claim cap currently in effect for this visitor. `resetMs` is the epoch ms the
// window clears; `label` is the human cap (e.g. "3 per hour"); `limit` is the count.
export type ClaimBlock = { resetMs: number; label: string; limit: number }
export type ClaimAllowance = { allowed: boolean; label: string; limit: number }

// Access Pass state passed from the server. `mode` is the admin toggle; `active`
// means this device holds a valid pass; `expiresAt` is null for lifetime keys or
// an epoch-ms expiry for temporary passes. When active, the CTA skips the gateway.
export type AccessPass = { mode: boolean; active: boolean; expiresAt: number | null }

// Live H:MM:SS / M:SS countdown shown in place of the Get-Account button while the
// visitor is over their per-service cap. Ticks every second and calls onExpire the
// moment the window resets so the button comes back without a page reload.
function RateLimitCountdown({
  block,
  service,
  onExpire,
}: {
  block: ClaimBlock
  service: "netflix" | "prime" | "crunchyroll"
  onExpire: () => void
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, block.resetMs - Date.now()))

  useEffect(() => {
    setRemaining(Math.max(0, block.resetMs - Date.now()))
    const id = setInterval(() => {
      const r = Math.max(0, block.resetMs - Date.now())
      setRemaining(r)
      if (r <= 0) {
        clearInterval(id)
        onExpire()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [block.resetMs, onExpire])

  const totalSeconds = Math.ceil(remaining / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  const clock = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  const serviceName = service === "prime" ? "Prime" : service === "crunchyroll" ? "Crunchyroll" : "Netflix"

  return (
    <div className="flex flex-col gap-3 border border-border bg-destructive/10 p-5" role="alert" aria-live="polite">
      <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-destructive">
        <TimerReset className="size-4" aria-hidden />
        Claim limit reached
      </span>
      <p className="text-sm font-medium leading-relaxed text-muted-foreground">
        You&apos;ve used all your free {serviceName} accounts for now (limit {block.label}). Any accounts you&apos;ve
        already claimed are still saved on your device — this only pauses claiming new ones.
      </p>
      <div className="flex flex-col items-center gap-1 border border-border bg-card p-4">
        <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Try again in</span>
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">{clock}</span>
      </div>
    </div>
  )
}

// Temporary passes are minted server-side as `now + 24h`, so the TRUE remaining can
// never exceed 24h. Lifetime passes never render this countdown. We clamp the displayed value to this ceiling because the countdown
// diffs an absolute server epoch against the CLIENT clock: a visitor whose device
// clock runs slow would otherwise see >24h (e.g. a 1h48m-slow clock rendered "25:48").
// Clamping only ever trims that client-side over-count — it can never shorten a real
// value, since the real value is already ≤ 24h.
const PASS_MAX_MS = 24 * 60 * 60 * 1000

// Live H:MM:SS countdown to a valid Access Pass's expiry. Calls onExpire when the
// window closes so the CTA reverts to the locked (gateway) state without a reload.
function PassCountdown({ expiresAt, onExpire }: { expiresAt: number; onExpire: () => void }) {
  const clampRemaining = (ms: number) => Math.min(PASS_MAX_MS, Math.max(0, ms))
  const [remaining, setRemaining] = useState(() => clampRemaining(expiresAt - Date.now()))

  useEffect(() => {
    setRemaining(clampRemaining(expiresAt - Date.now()))
    const id = setInterval(() => {
      const r = clampRemaining(expiresAt - Date.now())
      setRemaining(r)
      if (r <= 0) {
        clearInterval(id)
        onExpire()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [expiresAt, onExpire])

  const totalSeconds = Math.ceil(remaining / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return (
    <span className="font-mono tabular-nums">
      {h}:{pad(m)}:{pad(s)}
    </span>
  )
}

// Submit button with a pending state while the server action mints the token and
// redirects to LootLabs. Lives inside the <form> so useFormStatus sees it.
function SubmitButton({ available }: { available: number }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || available === 0}
      className="group inline-flex w-full items-center justify-center gap-2.5 border border-border bg-primary px-6 py-4 text-base font-semibold uppercase tracking-widest text-primary-foreground transition-all duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? (
        <>
          <Spinner className="size-5" /> Generating secure session…
        </>
      ) : (
        <>
          <Gift className="size-5" aria-hidden /> Get Account
          <ExternalLink className="size-4 opacity-70" aria-hidden />
        </>
      )}
    </button>
  )
}

export function AccountSelection({
  plans,
  countries,
  combos,
  untagged = 0,
  displayCombos = [],
  displayUntagged = 0,
  service = "netflix",
  showPlanSelection = true,
  showCountrySelection = true,
  initialBlock = null,
  accessPass = null,
  allowance,
}: {
  plans: string[]
  countries: string[]
  // Available accounts grouped by plan+country, used to compute the live counts.
  combos: Combo[]
  // 1-hour-delayed REAL counts grouped by plan+country, used ONLY for the visible
  // "N available" labels — never for gating. Empty until an hour of data accrues.
  displayCombos?: Combo[]
  // 1-hour-delayed REAL count of untagged accounts (folds into "Any/Any" display).
  displayUntagged?: number
  // Accounts with no plan/country metadata — distributable only under the
  // fully-unfiltered "Any plan / Any country" selection, so they're added to that
  // total only (never to a specific plan or country count).
  untagged?: number
  // Which streaming service this generator distributes; submitted with the form so
  // the reward session is bound to the correct pool.
  service?: "netflix" | "prime" | "crunchyroll"
  // When false, the plan picker is hidden and the plan is always submitted as
  // "any" — used by the Prime generator, which distributes without a plan choice.
  showPlanSelection?: boolean
  // When false, the country picker is hidden and the country is always submitted
  // as "any" — used by the Crunchyroll generator, which hands out a random account
  // with no plan OR country choice (the pool is limited).
  showCountrySelection?: boolean
  // Server-evaluated claim cap for THIS visitor at page-load time. When present the
  // countdown shows immediately (and the Get-Account button is hidden) so the limit
  // is visible on refresh, not only after an attempt. null = under the limit.
  initialBlock?: ClaimBlock | null
  // Access Pass state (admin toggle + this device's live 24h pass). When mode is on
  // and a pass is active, the CTA copy changes and the submit skips the gateway.
  // null / mode off → classic locked-gateway CTA (unchanged).
  accessPass?: AccessPass | null
  allowance: ClaimAllowance
}) {
  const [plan, setPlan] = useState("any")
  const [country, setCountry] = useState("any")

  // Track the active claim block. Seeded from the server's page-load check, then
  // updated if a Get-Account attempt comes back rate-limited (useActionState below).
  const [block, setBlock] = useState<ClaimBlock | null>(initialBlock)
  const [state, formAction] = useActionState<StartGenerationState, FormData>(startGeneration, { status: "idle" })

  useEffect(() => {
    if (state.status === "rate_limited") {
      setBlock({ resetMs: state.resetMs, label: state.label, limit: state.limit })
    }
  }, [state])

  // Cleared when the countdown reaches zero so the button returns without a reload.
  const handleExpire = useCallback(() => setBlock(null), [])
  const blocked = block !== null && block.resetMs > Date.now()

  // Whether this device's 24h Access Pass is currently active. Seeded from the
  // server, flipped to false when the pass countdown expires so the CTA reverts to
  // the gateway flow without a reload.
  const [passActive, setPassActive] = useState(
    Boolean(
      accessPass?.mode &&
        accessPass.active &&
        (accessPass.expiresAt === null || accessPass.expiresAt > Date.now()),
    ),
  )
  const handlePassExpire = useCallback(() => setPassActive(false), [])
  const passMode = Boolean(accessPass?.mode)
  const lifetimeKey = passMode && passActive && accessPass?.expiresAt === null
  const passUnlocked = passMode && passActive
  const allowanceWindow = allowance.label.replace(/^\d+\s*/, "").replace(/^per\s+/i, "")

  const planChoices = ["any", ...plans]

  // Count available accounts for a given plan, honoring the currently-selected
  // country filter ("any" = all countries). Drives the live numbers on each card.
  // Untagged accounts are folded in only for the "Any plan + Any country" case.
  const countForPlan = useMemo(
    () => (p: string) => {
      const base = combos.reduce(
        (sum, c) =>
          (p === "any" || c.plan === p) && (country === "any" || c.country === country) ? sum + c.count : sum,
        0,
      )
      return p === "any" && country === "any" ? base + untagged : base
    },
    [combos, country, untagged],
  )

  // Count available accounts for a given country, honoring the selected plan.
  // Untagged accounts are folded in only for the "Any country + Any plan" case.
  const countForCountry = useMemo(
    () => (cc: string) => {
      const base = combos.reduce(
        (sum, c) => ((cc === "any" || c.country === cc) && (plan === "any" || c.plan === plan) ? sum + c.count : sum),
        0,
      )
      return cc === "any" && plan === "any" ? base + untagged : base
    },
    [combos, plan, untagged],
  )

  // 1-hour-delayed REAL counts for a plan (honoring the selected country), mirroring
  // countForPlan but over displayCombos. Drives the visible "N available" label only.
  const displayForPlan = useMemo(
    () => (p: string) => {
      const base = displayCombos.reduce(
        (sum, c) =>
          (p === "any" || c.plan === p) && (country === "any" || c.country === country) ? sum + c.count : sum,
        0,
      )
      return p === "any" && country === "any" ? base + displayUntagged : base
    },
    [displayCombos, country, displayUntagged],
  )

  // 1-hour-delayed REAL counts for a country (honoring the selected plan).
  const displayForCountry = useMemo(
    () => (cc: string) => {
      const base = displayCombos.reduce(
        (sum, c) => ((cc === "any" || c.country === cc) && (plan === "any" || c.plan === plan) ? sum + c.count : sum),
        0,
      )
      return cc === "any" && plan === "any" ? base + displayUntagged : base
    },
    [displayCombos, plan, displayUntagged],
  )

  const available = countForPlan(plan)

  // Country dropdown options: full country names (resolved from ISO codes) sorted
  // alphabetically, with a leading "Any country" entry. Disabled when empty so the
  // user can't pick an unfulfillable country.
  const countryOptions = useMemo<SelectOption[]>(() => {
    const anyCount = countForCountry("any")
    const rest = countries
      .map((c) => {
        const n = countForCountry(c)
        const name = countryName(c)
        return {
          value: c,
          label: name,
          // Real count from ~1h ago when in stock; disabled strictly on live stock.
          hint: stockLabel(n, displayForCountry(c)),
          disabled: n === 0,
          // Let users search by full name OR the raw ISO code.
          keywords: `${name} ${c}`,
          count: n,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(({ count: _count, ...opt }) => opt)

    return [{ value: "any", label: "Any country", hint: stockLabel(anyCount, displayForCountry("any")) }, ...rest]
  }, [countries, countForCountry, displayForCountry])

  return (
    <form action={formAction} className="flex flex-col gap-8">
      {/* Hidden fields carry the selection into the server action. */}
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="country" value={country} />
      <input type="hidden" name="service" value={service} />

      {/* Stock display — shown when there's no plan/country picker (Crunchyroll).
 Exact stock counts are intentionally hidden; we only show whether accounts
 are available or not, never a number or per-plan breakdown. */}
      {!showPlanSelection && !showCountrySelection && (
        <div className="flex items-center justify-between gap-3 border border-border bg-card p-5 ">
          <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-foreground">
            <Gift className="size-4 text-accent" aria-hidden />
            Accounts in stock
          </span>
          <span
            className={cn(
              "border border-border px-3 py-1.5 text-sm font-semibold uppercase tracking-widest",
              available === 0 ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground",
            )}
          >
            {stockLabel(available, displayForPlan(plan))}
          </span>
        </div>
      )}

      {/* Plan selection — hidden for services that distribute without a plan choice. */}
      {showPlanSelection && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-foreground">
            <span className="flex size-6 items-center justify-center border border-border bg-accent text-[11px] text-accent-foreground">
              1
            </span>
            Choose a plan
          </legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {planChoices.map((p) => {
              const selected = plan === p
              const n = countForPlan(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlan(p)}
                  aria-pressed={selected}
                  disabled={n === 0}
                  className={cn(
                    "relative flex flex-col gap-1.5 border border-border px-4 py-3 text-left transition-all duration-75",
                    selected ? "bg-primary text-primary-foreground shadow-lg" : "bg-card text-foreground hover:",
                    n === 0 && "cursor-not-allowed opacity-40 ",
                  )}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold uppercase tracking-wide">
                    {p === "any" ? "Any plan" : p}
                    {selected && <Check className="size-4 shrink-0" aria-hidden />}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] font-bold uppercase tracking-widest",
                      selected ? "text-primary-foreground/80" : "text-muted-foreground",
                    )}
                  >
                    {stockLabel(n, displayForPlan(p))}
                  </span>
                </button>
              )
            })}
          </div>
        </fieldset>
      )}

      {/* Country selection — hidden for services that hand out a random account
 with no country choice (Crunchyroll). */}
      {showCountrySelection && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-foreground">
            <span className="flex size-6 items-center justify-center border border-border bg-accent text-[11px] text-accent-foreground">
              {showPlanSelection ? "2" : "1"}
            </span>
            Choose a country
          </legend>
          <SelectDropdown
            options={countryOptions}
            value={country}
            onChange={setCountry}
            ariaLabel="Country"
            searchable
            searchPlaceholder="Search countries…"
            leading={<Globe className="size-4" aria-hidden />}
          />
        </fieldset>
      )}

      {/* When the visitor is over their per-service cap we show a live countdown
 INSTEAD of the unlock button, so they can't even open the LootLabs link
 until their window resets. Otherwise show the normal locked CTA. */}
      {blocked && block ? (
        <RateLimitCountdown block={block} service={service} onExpire={handleExpire} />
      ) : passUnlocked ? (
        <div className="flex flex-col gap-3 border border-accent bg-accent/10 p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-accent">
              <Ticket className="size-4" aria-hidden />
              {lifetimeKey ? "Lifetime access" : "Access unlocked"}
            </span>
            <span className="border border-border bg-accent px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-accent-foreground">
              {stockLabel(available, displayForPlan(plan))}
            </span>
          </div>
          <p className="text-sm font-medium leading-relaxed text-muted-foreground">
            {lifetimeKey ? (
              <>Your lifetime key is active on this device. You can claim accounts without another unlock step. Your {service} limit is <span className="font-semibold text-foreground">{allowance.limit} per {allowanceWindow}</span>; live checks still apply.</>
            ) : (
              <>Your 24-hour access pass is active — no extra step needed. Time left:{" "}<span className="font-semibold text-foreground"><PassCountdown expiresAt={accessPass!.expiresAt as number} onExpire={handlePassExpire} /></span>. Your limit is <span className="font-semibold text-foreground">{allowance.limit} per {allowanceWindow}</span>.</>
            )}
          </p>
          <SubmitButton available={available} />
          {available === 0 && (
            <p className="text-xs font-bold uppercase tracking-widest text-destructive">
              {showPlanSelection || showCountrySelection
                ? "No accounts match this combination — try a different plan or country."
                : "No accounts are available right now — please check back soon."}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 border border-border bg-card p-5 ">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-foreground">
              <Lock className="size-4 text-accent" aria-hidden />
              Locked — one quick step to unlock
            </span>
            <span className="border border-border bg-accent px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-accent-foreground">
              {stockLabel(available, displayForPlan(plan))}
            </span>
          </div>
          <p className="text-sm font-medium leading-relaxed text-muted-foreground">
            {passMode ? (
              <>
                Complete one quick step to unlock <span className="font-semibold text-foreground">all generators</span>{" "}
                for <span className="font-semibold text-foreground">24 hours</span> — Netflix, Prime and Crunchyroll,
                no more steps until it expires. Your account is checked live and revealed the moment you come back.
              </>
            ) : (
              <>
                Free access includes one short verification step. Complete it and your account is checked live and revealed when you return — no sign-up needed. Your current {service} limit is <span className="font-semibold text-foreground">{allowance.limit} per {allowanceWindow}</span>.
              </>
            )}
          </p>
          <SubmitButton available={available} />
          {available === 0 && (
            <p className="text-xs font-bold uppercase tracking-widest text-destructive">
              {showPlanSelection || showCountrySelection
                ? "No accounts match this combination — try a different plan or country."
                : "No accounts are available right now — please check back soon."}
            </p>
          )}
        </div>
      )}
    </form>
  )
}
