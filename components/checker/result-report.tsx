"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  XCircle,
  Mail,
  CreditCard,
  Calendar,
  Globe,
  CalendarClock,
  Phone,
  User,
  Monitor,
  Smartphone,
  Tv,
  Copy,
  Check,
  ShieldCheck,
  Link2,
  ChevronDown,
  FileText,
  Braces,
  Eye,
  ExternalLink,
  Gamepad2,
  Clock,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  copyText,
  buildAccountDetails,
  cookieToCookieEditorJson,
  cookieToNetscape,
  prepareCookieForCheck,
  normalizePlan,
  isAliveResult,
  isPlanExpired,
  type CheckResult,
} from "@/lib/cookie-utils"

export function ResultReport({
  result,
  cookie,
  service = "netflix",
  hideCookies = false,
}: {
  result: CheckResult
  cookie: string
  // "Trimmed" services (Prime, Crunchyroll) hide Netflix-only fields — email,
  // payment, billing, phone, the "+Extra" badge, and Direct Auth Links.
  // • Prime → Status · Country · Profiles · Name (NO plan).
  // • Crunchyroll → Status · Plan/Tier · Country · Profiles · Name (plan kept,
  // since the membership tier is the whole point of the check).
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" | "steam" | "spotify"
  // When true, all cookie copy actions (Copy full details, Copy cookies, raw,
  // Netscape, manual reveal) are hidden. Only Direct Auth Links remain visible.
  // Used by the Netflix generator when the admin enables "links only" mode.
  hideCookies?: boolean
}) {
  const isPrime = service === "prime"
  const isCrunchyroll = service === "crunchyroll"
  const isSteam = service === "steam"
  const isSpotify = service === "spotify"
  // Prime, Crunchyroll, Steam and Spotify all use the slimmed identity layout
  // (account name hero, no Netflix billing/profile readout).
  const isTrimmed = isPrime || isCrunchyroll || isSteam || isSpotify
  // Services that surface a Plan/Tier + Region readout (everything trimmed except
  // Prime, which intentionally shows Region only).
  const showPlanRow = isCrunchyroll || isSteam || isSpotify
  // The account/profile username is the "name" shown as the hero for trimmed
  // services (the first profile is the primary/account profile).
  const accountName = result.profiles?.[0]
  if (!isAliveResult(result)) {
    const expired = result.valid && isPlanExpired(result.plan)
    // Netflix payment-failure hold: logs in but can't stream, so it's dead — but we
    // label it precisely instead of a generic failure.
    const onHold = Boolean(result.membershipOnHold)
    const regionLocked = Boolean(result.regionLocked)
    // A "logged in, but no subscription" result is dead, yet still carries
    // context (plan/region/profiles) worth surfacing so it's clear WHY.
    const noPrime = /no prime/i.test(result.plan ?? "")
    const deadStats = [
      // Prime drops the plan row entirely; Netflix and Crunchyroll keep it
      // (Crunchyroll's "No subscription" plan is the reason it's dead).
      ...(isPrime ? [] : [{ icon: ShieldCheck, label: "Plan", value: result.plan }]),
      { icon: Globe, label: isTrimmed ? "Region" : "Country", value: result.countryCode },
    ].filter((s) => s.value)
    return (
      <section className="flex flex-col gap-3 rounded-md border border-destructive/50 glass p-6 duration-500 anim-condense">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-destructive text-white ">
            <XCircle className="size-5" aria-hidden />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold uppercase tracking-widest text-destructive">
              {onHold ? "Account On Hold" : regionLocked ? "Region Locked" : "Cookie Is Dead"}
            </h2>
            <span className="text-xs font-bold text-destructive">
              {onHold
                ? `Payment failed — on hold${result.plan ? ` (${result.plan})` : ""}`
                : regionLocked
                  ? "Unavailable in the checker region"
                  : noPrime
                  ? "No active Prime subscription"
                  : isCrunchyroll && /no subscription/i.test(result.plan ?? "")
                    ? "No active Crunchyroll subscription"
                    : expired
                      ? `Plan expired${result.plan ? ` (${result.plan})` : ""}`
                      : "Verification failed"}
            </span>
          </div>
        </div>
        <p className="text-sm font-medium leading-relaxed text-muted-foreground">
          {onHold
            ? "This Netflix login works, but the account's last payment failed and it's on hold — so it can't stream and is treated as dead."
            : regionLocked
              ? "This session is valid, but Netflix reported regional unavailability. It is treated as dead for now."
              : noPrime
              ? "This Amazon login works, but the account has no active Prime subscription — so it can't stream and is treated as dead."
              : isCrunchyroll && /no subscription/i.test(result.plan ?? "")
                ? "This Crunchyroll login works, but the account has no active premium membership — so it's treated as dead."
                : expired
                  ? "This session's plan has expired, so it is treated as dead."
                  : result.message || "This cookie has expired or is invalid."}
        </p>
        {(deadStats.length > 0 || (!isTrimmed && result.profiles && result.profiles.length > 0)) && (
          <div className="flex flex-col gap-2 border-t border-destructive/40 pt-3">
            {deadStats.map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-2.5">
                <Icon className="size-4 shrink-0 text-foreground" aria-hidden />
                <span className="w-20 shrink-0 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  {label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">{value}</span>
              </div>
            ))}
            {/* Profiles are a Netflix-only readout — Prime & Crunchyroll omit them. */}
            {!isTrimmed && result.profiles && result.profiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  <User className="size-3.5 text-foreground" aria-hidden />
                  {result.profiles.length} profile{result.profiles.length > 1 ? "s" : ""}
                </span>
                {result.profiles.map((name) => (
                  <span
                    key={name}
                    className="rounded-md border border-border bg-card px-3 py-1 text-xs font-bold text-foreground"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    )
  }

  // Secondary stats rendered as a single aligned readout list (NOT icon tiles),
  // so the layout reads like a diagnostic dossier rather than a card grid.
  // • Prime → Region only (mirrors the reference checker; no plan).
  // • Crunchyroll → Plan/Tier + Region (the membership tier is the key info).
  // • Netflix → full billing/identity readout (unchanged).
  const stats: { icon: typeof Mail; label: string; value?: string }[] = (
    isPrime
      ? [{ icon: Globe, label: "Region", value: result.countryCode }]
      : showPlanRow
        ? [
            { icon: ShieldCheck, label: isSteam ? "Status" : "Plan", value: result.plan },
            { icon: Globe, label: "Region", value: result.countryCode },
            ...(isSteam && (result.gameCount ?? result.games?.length)
              ? [
                  {
                    icon: Gamepad2,
                    label: "Games owned",
                    value: String(result.gameCount ?? result.games!.length),
                  },
                ]
              : []),
          ]
        : [
            { icon: Globe, label: "Country", value: result.countryCode },
            { icon: CreditCard, label: "Payment", value: result.paymentMethod },
            { icon: CalendarClock, label: "Member since", value: result.memberSince },
            { icon: Calendar, label: "Next billing", value: result.nextBillingCycle },
            { icon: Phone, label: "Phone", value: result.phone },
            { icon: Monitor, label: "Max streams", value: result.maxStreams ? String(result.maxStreams) : undefined },
          ]
  ).filter((s) => s.value)

  return (
    <section className="overflow-hidden rounded-md glass duration-500 anim-condense">
      {/* Status ribbon */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-success/15 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="size-4 text-success" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-foreground">Analysis Report</span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-success px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white">
          <span className="size-2 bg-white" aria-hidden />
          {result.demo ? "Alive · Demo" : "Alive"}
        </span>
      </div>

      <div className="flex flex-col gap-5 p-5 sm:p-6">
        {!hideCookies && (
          <>
            {/* Identity band. Netflix leads with email; trimmed services (Prime,
            Crunchyroll) have no email/billing identity, so they lead with the
            account/profile NAME as the hero. */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-primary text-primary-foreground ">
              {isTrimmed ? <User className="size-5" aria-hidden /> : <Mail className="size-5" aria-hidden />}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                {isTrimmed ? "Name" : "Email"}
              </span>
              <span className="truncate text-base font-semibold text-foreground">
                {isTrimmed
                  ? (accountName ?? (isPrime ? "Prime account" : "Crunchyroll account"))
                  : (result.email ?? "Unknown email")}
              </span>
            </div>
          </div>
          {!isTrimmed && (
            <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
              {normalizePlan(result.plan) && (
                <span className="inline-flex items-center gap-2 rounded-md border border-border bg-primary px-3.5 py-2 text-sm font-semibold uppercase tracking-wider text-primary-foreground">
                  <ShieldCheck className="size-4" aria-hidden />
                  {normalizePlan(result.plan)}
                </span>
              )}
              {result.extraMember && (
                <span className="inline-flex items-center rounded-md border border-border bg-accent px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-accent-foreground">
                  +Extra
                </span>
              )}
            </div>
          )}
        </div>

        {/* Aligned key/value readout — distinct from the inspiration's tile grid */}
        {stats.length > 0 && (
          <dl className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {stats.map(({ icon: Icon, label, value }, i) => (
              <div
                key={label}
                className="anim-condense flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <Icon className="size-4 shrink-0 text-foreground" aria-hidden />
                <dt className="w-32 shrink-0 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  {label}
                </dt>
                <dd className="min-w-0 flex-1 truncate text-right font-mono text-sm font-semibold text-foreground sm:text-left">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {/* Steam owned-games library — full list, most-played first. */}
            {isSteam && result.games && result.games.length > 0 && (
              <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <Gamepad2 className="size-4 text-accent" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-widest text-foreground">
                {result.gameCount ?? result.games.length} Game{(result.gameCount ?? result.games.length) > 1 ? "s" : ""}{" "}
                Owned
              </span>
            </div>
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card">
              {result.games.map((g) => (
                <li key={g.appId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <a
                    href={`https://store.steampowered.com/app/${g.appId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${g.name} on the Steam store`}
                    className="min-w-0 flex-1 truncate text-sm font-bold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {g.name}
                  </a>
                  {typeof g.hoursOnRecord === "number" && g.hoursOnRecord > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden />
                      {g.hoursOnRecord.toLocaleString()} h
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
            )}
          </>
        )}

        {/* Netflix profiles remain visible in reward links-only mode. */}
        {service === "netflix" && result.profiles && result.profiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              <User className="size-3.5 text-foreground" aria-hidden />
              {result.profiles.length} profile{result.profiles.length > 1 ? "s" : ""}
            </span>
            {result.profiles.map((name) => (
              <span
                key={name}
                className="rounded-md border border-border bg-card px-3 py-1 text-xs font-bold text-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        )}

        {!isTrimmed && result.links && (result.links.pc || result.links.mobile || result.links.tv) && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <Link2 className="size-4 text-accent" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-widest text-foreground">Direct Auth Links</span>
            </div>
            {result.links.pc && <LinkRow icon={Monitor} label="PC" url={result.links.pc} />}
            {result.links.mobile && <LinkRow icon={Smartphone} label="Mobile" url={result.links.mobile} />}
            {result.links.tv && <LinkRow icon={Tv} label="TV" url={result.links.tv} />}
          </div>
        )}

        {!hideCookies && <CopyDetailsActions result={result} cookie={cookie} service={service} />}
      </div>
    </section>
  )
}

function LinkRow({ icon: Icon, label, url }: { icon: typeof Mail; label: string; url: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const ok = await copyText(url)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success(`${label} link copied`)
    } else {
      toast.error("Couldn't copy. Select the URL manually.")
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2">
      {/* Clickable device badge — opens the auth link in a new tab. Fixed width +
 shrink-0 icon keeps PC / MOBILE / TV visually consistent. */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${label} login in a new tab`}
        className="group/link inline-flex w-24 shrink-0 items-center gap-1.5 rounded-md border border-border bg-primary px-2.5 py-2 text-xs font-semibold uppercase tracking-widest text-primary-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Icon className="size-3.5 shrink-0 transition-transform duration-300 group-hover/link:scale-110" aria-hidden />
        <span className="truncate">{label}</span>
      </a>
      <input
        readOnly
        value={url}
        aria-label={`${label} URL`}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} link in a new tab`}
        title={`Open ${label} link in a new tab`}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <ExternalLink className="size-4" aria-hidden />
      </a>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={copy}
        aria-label={`Copy ${label} URL`}
        className="shrink-0"
      >
        {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </Button>
    </div>
  )
}

function CopyDetailsActions({
  result,
  cookie,
  service = "netflix",
}: {
  result: CheckResult
  cookie: string
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
}) {
  // Tracks WHICH button was just copied so only that button flips to its "Copied"
  // state (three independent primary actions now share this row).
  const [copiedKey, setCopiedKey] = useState<null | "json" | "details" | "raw">(null)
  // Which block to reveal for manual (select-all) copying when auto-copy is blocked
  // OR when the user explicitly wants to grab the text. "json" = importable
  // Cookie-Editor array, "details" = human-readable report, "raw" = request header.
  const [manual, setManual] = useState<null | "json" | "details" | "raw">(null)
  const details = buildAccountDetails(result, cookie, undefined, service)
  // The browser-importable Cookie-Editor / EditThisCookie JSON array — the one-click
  // "Import" format that loads a FULL working session into any browser
  // (Chrome/Edge/Firefox/Brave/Opera/Safari). This is what must be pasted into the
  // extension's Import box; the full-details block is human-readable text and is NOT
  // valid JSON, which is why pasting it into Cookie-Editor throws "failed to parse".
  const jsonCookie = cookieToCookieEditorJson(cookie, service)
  const primeNetscapeCookie = service === "prime" ? cookieToNetscape(cookie, "prime") : jsonCookie
  const cookieConversionFailed = service === "prime" ? primeNetscapeCookie === "# Netscape HTTP Cookie File" : jsonCookie === "[]"
  // Netscape cookies.txt — the alternative import format for tools/extensions that
  // take a cookies.txt file instead of JSON (e.g. "Get cookies.txt", yt-dlp).
  const netscapeCookie = cookieToNetscape(cookie, service)
  // RAW request-header cookie string ("name=value; name=value") — the exact,
  // service-scoped header the checker itself sends. This is the "copy cookie as raw"
  // format for tools/scripts that want a plain header rather than JSON/Netscape.
  const rawCookie = prepareCookieForCheck(cookie, service).cookie || cookie

  async function run(
    text: string,
    label: string,
    key: "json" | "details" | "raw",
    manualKind: "json" | "details" | "raw" = key,
    requiresCookieConversion = false,
  ) {
    if (requiresCookieConversion && cookieConversionFailed) {
      toast.error("This saved cookie data is invalid or incomplete. Re-import the original cookie export.")
      return
    }
    if (!text || text === "[]") {
      toast.info(`Nothing to copy for ${label}.`)
      return
    }
    const ok = await copyText(text)
    if (ok) {
      toast.success(`${label} copied`)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
    } else {
      setManual(manualKind)
      toast.error("Auto-copy is blocked here. Select the text below to copy manually.")
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      {/* TWO main copy actions. #1 (primary) is the browser-import login cookie — the
          valid Cookie-Editor JSON array you paste into the extension's Import box. It
          MUST be the prominent action: users kept clicking the old primary "Copy full
          details" and pasting that human-readable block into Cookie-Editor, which is
          NOT JSON and throws "failed to parse". #2 (secondary) is the readable details.
          The grid stacks to one column on phones and splits into two on wider screens
          so both buttons stay tappable. A compact "more" dropdown keeps the alternate
          cookie formats (raw + Netscape) and the manual-copy fallbacks. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button
          type="button"
          size="lg"
          onClick={() => run(primeNetscapeCookie, service === "prime" ? "Netscape cookie" : "Login cookie", "json", "json", true)}
          className="w-full min-w-0"
        >
          {copiedKey === "json" ? (
            <Check className="size-4 shrink-0" aria-hidden />
          ) : (
            <Braces className="size-4 shrink-0" aria-hidden />
          )}
          <span className="truncate">{copiedKey === "json" ? "Copied" : service === "prime" ? "Copy cookies (Netscape)" : "Copy cookies (for import)"}</span>
        </Button>

        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={() => run(details, "Full details", "details")}
          className="w-full min-w-0"
        >
          {copiedKey === "details" ? (
            <Check className="size-4 shrink-0" aria-hidden />
          ) : (
            <Copy className="size-4 shrink-0" aria-hidden />
          )}
          <span className="truncate">{copiedKey === "details" ? "Copied" : "Copy full details"}</span>
        </Button>
      </div>

      {/* Alternate cookie formats + manual fallbacks tucked into a right-aligned menu. */}
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More copy options"
            className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-all duration-75 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-expanded:bg-primary aria-expanded:text-primary-foreground"
          >
            More options
            <ChevronDown className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onClick={() => run(rawCookie, "Raw cookie", "raw")}>
              <FileText className="size-4" aria-hidden />
              Copy cookies (raw)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run(netscapeCookie, "Netscape cookie", "json", "json", true)}>
              <FileText className="size-4" aria-hidden />
              Copy cookies (Netscape)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setManual((v) => (v === "details" ? null : "details"))}>
              <Eye className="size-4" aria-hidden />
              {manual === "details" ? "Hide details text" : "Show full details manually"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (cookieConversionFailed) {
                  toast.error("This saved cookie data is invalid or incomplete. Re-import the original cookie export.")
                  return
                }
                setManual((v) => (v === "json" ? null : "json"))
              }}
            >
              <Eye className="size-4" aria-hidden />
              {manual === "json" ? "Hide cookie text" : "Show cookies to copy manually"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setManual((v) => (v === "raw" ? null : "raw"))}>
              <Eye className="size-4" aria-hidden />
              {manual === "raw" ? "Hide raw cookie" : "Show raw cookie manually"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {cookieConversionFailed && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-relaxed text-destructive">
          This saved cookie data is invalid or incomplete and cannot be converted for browser import. Re-import the original cookie export to replace it.
        </p>
      )}

      {/* Short, unambiguous import instruction so users stop pasting the wrong block. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Install the{" "}
        <a
          href="https://cookie-editor.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline underline-offset-2"
        >
          Cookie-Editor
        </a>{" "}
        extension, open it on the service&apos;s site, click{" "}
        <span className="font-semibold text-foreground">Import</span>, paste, then refresh the page to
        land on a full logged-in session.
      </p>

      {manual === "json" && (
        <textarea
          readOnly
value={primeNetscapeCookie}
  onFocus={(e) => e.currentTarget.select()}
  rows={10}
  aria-label={service === "prime" ? "Prime Netscape cookies — select all to copy into cookies.txt" : "Login cookie JSON — select all to copy, then paste into Cookie-Editor Import"}
          className="w-full resize-y rounded-md border border-border bg-muted px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground duration-200 animate-in fade-in-0 slide-in-from-top-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
      )}

      {manual === "details" && (
        <textarea
          readOnly
          value={details}
          onFocus={(e) => e.currentTarget.select()}
          rows={10}
          aria-label="Full session details — select all to copy manually"
          className="w-full resize-y rounded-md border border-border bg-muted px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground duration-200 animate-in fade-in-0 slide-in-from-top-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
      )}

      {manual === "raw" && (
        <textarea
          readOnly
          value={rawCookie}
          onFocus={(e) => e.currentTarget.select()}
          rows={6}
          aria-label="Raw request-header cookie — select all to copy manually"
          className="w-full resize-y rounded-md border border-border bg-muted px-4 py-3 font-mono text-[11px] leading-relaxed break-all text-foreground duration-200 animate-in fade-in-0 slide-in-from-top-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
      )}
    </div>
  )
}
