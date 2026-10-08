"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ShieldCheck,
  ShieldQuestion,
  CircleCheck,
  XCircle,
  Info,
  Trash2,
  FileUp,
  TerminalSquare,
  Link2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ResultReport } from "@/components/checker/result-report"
import {
  analyzeCookie,
  checkCookie,
  cookieForStorage,
  detectFormat,
  detectService,
  isAliveResult,
  prepareCookieForCheck,
  serializeCookies,
  serviceDefaultDomain,
  splitCookiesAndText,
  type CheckResult,
  type CookieFormat,
} from "@/lib/cookie-utils"
import { errorLabel, isRetryable } from "@/lib/check-errors"
import { playSuccess, playDead, playError } from "@/lib/sound"

// Optional callback fired with each alive result (cleaned cookie + parsed data).
// The public checker omits it; the admin checker uses it to persist to the DB.
export type OnAlive = (entries: { cookie: string; result: CheckResult }[]) => void

export function SingleChecker({
  onAlive,
  service = "netflix",
  autoDetect = false,
  allowedServices,
  onDetect,
  linksOnly = false,
}: {
  onAlive?: OnAlive
  // Which service to validate against; threaded into the /api/check call.
  service?: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify"
  // When true (smart checker "Auto" mode), the service is inferred from the pasted
  // cookie at check time instead of being fixed. Default OFF keeps every existing
  // caller (classic /netflix, /prime, /crunchyroll, admin) behaving exactly as before.
  autoDetect?: boolean
  // Restricts auto-detection to admin-enabled services (smart checker only).
  allowedServices?: readonly ("netflix" | "prime" | "crunchyroll")[]
  // Fires with the detected service (or null) so a parent can reflect it in the UI.
  onDetect?: (svc: "netflix" | "prime" | "crunchyroll" | null) => void
  // When true, cookie copy actions are hidden from the result report.
  linksOnly?: boolean
}) {
  const [cookie, setCookie] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Mint Netflix login/auth links for alive cookies. ON by default for the SINGLE
  // checker: it's one cookie at a time, so the extra upstream request is cheap and
  // users almost always want the login links here. (Bulk keeps this OFF by default,
  // where the per-alive cost compounds across a large run.)
  const [includeLinks, setIncludeLinks] = useState(true)

  // In Auto mode the service is inferred from the pasted cookie; otherwise it's the
  // fixed prop. `detected` is null when nothing recognizable is pasted yet.
  const detected = useMemo(
    () => (autoDetect ? detectService(cookie, allowedServices) : null),
    [autoDetect, cookie, allowedServices],
  )
  // The service actually used for checking/formatting/rendering. Falls back to the
  // fixed prop when not auto-detecting, or to "netflix" as a harmless placeholder
  // for the idle (empty) auto state — a check is blocked until detection succeeds.
  const effectiveService: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" = autoDetect
    ? detected ?? "netflix"
    : service

  // Let a parent (smart checker) mirror the detected service in its own UI.
  useEffect(() => {
    if (autoDetect) onDetect?.(detected)
  }, [autoDetect, detected, onDetect])

  // Direct auto-login links (nftoken) are a Netflix-only feature — Prime and
  // Crunchyroll have no equivalent, so the toggle is hidden and never requested
  // for them (the result panel also omits the "Direct Auth Links" section there).
  const isNetflix = effectiveService === "netflix"

  const analysis = useMemo(() => analyzeCookie(cookie), [cookie])
  const isEmpty = !cookie.trim()

  // NOTE: the single checker does NOT scrape proxies. A single check goes DIRECT
  // (server-side) for the fastest possible result and no proxy-induced false
  // deads, so there's nothing to pre-warm here — the check fires instantly.

  function handleConvert(target: CookieFormat) {
    if (isEmpty) {
      toast.info("Paste a cookie first to convert it.")
      return
    }
    if (target === analysis.format) {
      toast.info(`Already in ${target} format.`)
      return
    }
    const { entries, extra } = splitCookiesAndText(cookie, analysis.format)
    if (entries.length === 0) {
      toast.error(`Couldn't parse the cookie as ${analysis.format}.`)
      return
    }
    // Stamp the correct service domain on domainless (RAW) cookies so the converted
    // NETSCAPE/JSON is valid and round-trips cleanly back to any format.
    const cookieOut = serializeCookies(entries, target, serviceDefaultDomain(effectiveService))
    const output = extra.trim() ? `${extra.trimEnd()}\n${cookieOut}` : cookieOut
    setCookie(output)
    toast.success(`Converted to ${target}.`)
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    if (file.size > 2_000_000) {
      toast.error("File is too large (max 2 MB).")
      return
    }
    try {
      const text = await file.text()
      setCookie(text)
      toast.success(`Loaded ${file.name}`)
    } catch {
      toast.error("Couldn't read that file.")
    }
  }

  async function handleCheck() {
    if (isEmpty || loading) return

    const fmt = detectFormat(cookie)
    const allEntries = splitCookiesAndText(cookie, fmt).entries
    if (allEntries.length === 0) {
      setError("No valid cookies found in the pasted text.")
      toast.error("No valid cookies found in the pasted text.")
      return
    }

    // Auto mode: refuse to guess when the cookie matches no known service — tell the
    // user to pick one manually rather than silently checking against the wrong site.
    if (autoDetect && !detected) {
      const msg = "Couldn't auto-detect the service from this cookie — pick a service manually."
      setError(msg)
      toast.error(msg)
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await checkCookie(cookie, undefined, {
        includeLinks: isNetflix && includeLinks,
        service: effectiveService,
      })
      // An errorCategory means the cookie could NOT be verified (upstream down,
      // timeout, rate limit, …) — that is a service error, not a dead cookie.
      // Surface it as an error state instead of mislabeling it "COOKIE_IS_DEAD".
      if (data.errorCategory) {
        const label = errorLabel(data.errorCategory)
        const retry = isRetryable(data.errorCategory) ? " Please try again in a moment." : ""
        const msg = `${label}: could not verify this cookie.${retry}`
        setError(msg)
        toast.error(msg)
        playError()
        return
      }
      setResult(data)
      if (data.valid) {
        toast.success(data.demo ? "Cookie is alive (demo data)." : "Cookie is alive.")
        playSuccess()
        // Surface alive results to an optional consumer (admin = persist to DB).
        if (onAlive && isAliveResult(data)) {
          // Persist the FULL service cookie set (not the lean auth slice used for
          // checking) so an exported/claimed account carries every cookie a browser
          // needs to log in — critical for Prime, whose session needs more than the
          // single `at-main` auth token. Fall back to the check slice if nothing parses.
          const stored =
            cookieForStorage(cookie, effectiveService) ||
            prepareCookieForCheck(cookie, effectiveService).cookie
          if (stored) onAlive([{ cookie: stored, result: data }])
        }
      } else {
        toast.warning(data.message || "Cookie is dead or invalid.")
        playDead()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong."
      setError(msg)
      toast.error(msg)
      playError()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
      {/* Input panel — terminal "code editor" frame: a toolbar, the textarea,
 and an integrated diagnostic status bar (instead of a separate boxed
 stat grid), for a distinct layout. */}
      <section className="anim-condense flex flex-col gap-4 rounded-xl glass p-6 sm:p-7">
        {/* Header with a live status pill */}
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
            <TerminalSquare className="size-5" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base font-semibold tracking-tight text-foreground">Single Cookie</h2>
            <p className="text-sm text-muted-foreground">Paste your cookie or load a file to check.</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 self-center rounded-full border border-border bg-secondary px-2.5 py-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            <span className={`size-1.5 rounded-full ${isEmpty ? "bg-muted-foreground" : "bg-primary"}`} aria-hidden />
            {isEmpty ? "idle" : "ready"}
          </span>
        </div>

        {/* Editor frame */}
        <div className="overflow-hidden rounded-lg border border-border bg-card/40 transition-all duration-150 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
          {/* Toolbar: window dots + filename, format toggles on the right */}
          <div className="flex items-center justify-between gap-2 border-b border-border bg-secondary px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-destructive/80" />
                <span className="size-2.5 rounded-full bg-muted-foreground/40" />
                <span className="size-2.5 rounded-full bg-primary/80" />
              </span>
              <label htmlFor="cookie" className="text-[11px] tracking-widest text-muted-foreground">
                cookie_input
              </label>
            </div>
            <div className="flex items-center gap-1">
              {(["RAW", "NETSCAPE", "JSON"] as const).map((f) => {
                const active = analysis.format === f && !isEmpty
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => handleConvert(f)}
                    disabled={isEmpty}
                    title={active ? `Detected: ${f}` : `Convert to ${f}`}
                    className={
                      active
                        ? "rounded-md border border-primary/40 bg-primary/15 px-2.5 py-0.5 text-[10px] tracking-widest text-primary"
                        : "rounded-md border border-transparent px-2.5 py-0.5 text-[10px] tracking-widest text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    }
                  >
                    {f}
                  </button>
                )
              })}
            </div>
          </div>

          <textarea
            id="cookie"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="> paste your cookie string here (RAW, Netscape, or JSON)…"
            rows={8}
            spellCheck={false}
            className="block w-full resize-y border-0 bg-transparent px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0"
          />

          {/* Integrated diagnostic status bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-secondary px-3.5 py-2 text-[11px]">
            <Diag label="fmt">
              <span className={analysis.total > 0 ? "font-semibold text-primary" : "text-muted-foreground"}>
                {analysis.total > 0 ? analysis.format.toLowerCase() : "--"}
              </span>
            </Diag>
            <Diag label="count">
              <span className="font-semibold text-primary">{analysis.total}</span>
            </Diag>
            {effectiveService === "prime" ? (
              <>
                <Diag label="at-main">
                  <Flag ok={analysis.primeAuth} />
                </Diag>
                <Diag label="session">
                  <Flag ok={analysis.primeSession} />
                </Diag>
              </>
            ) : effectiveService === "crunchyroll" ? (
              <Diag label="etp_rt">
                <Flag ok={analysis.crunchyrollAuth} />
              </Diag>
            ) : (
              <>
                <Diag label="id">
                  <Flag ok={analysis.netflixId} />
                </Diag>
                <Diag label="secure">
                  <Flag ok={analysis.secureNetflixId} />
                </Diag>
              </>
            )}
            <span className="ml-auto text-muted-foreground/70">
              {isEmpty ? (
                <>
                  await_input<span className="tc-blink text-primary">_</span>
                </>
              ) : (
                "parsed_ok"
              )}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="press inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-secondary px-4 text-xs tracking-widest text-foreground transition-colors hover:border-primary/40 hover:bg-muted">
            <FileUp className="size-3.5" aria-hidden />
            Load file
            <input
              type="file"
              accept=".txt,.json,text/plain,application/json"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0])
                e.target.value = ""
              }}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isEmpty}
            onClick={() => {
              setCookie("")
              setResult(null)
              setError(null)
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Clear
          </Button>

          {isNetflix && (
            <button
              type="button"
              role="switch"
              aria-checked={includeLinks}
              onClick={() => setIncludeLinks((v) => !v)}
              title="Also generate Netflix login links for alive cookies (slower)"
              className={
                includeLinks
                  ? "press inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/15 px-4 text-xs tracking-widest text-primary transition-colors"
                  : "press inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-secondary px-4 text-xs tracking-widest text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              }
            >
              <Link2 className="size-3.5" aria-hidden />
              Direct Link: {includeLinks ? "on" : "off"}
            </button>
          )}

          <Button
            type="button"
            size="lg"
            className="ml-auto h-11 min-w-[200px] flex-1 text-sm sm:flex-none"
            disabled={loading || isEmpty}
            onClick={handleCheck}
          >
            {loading ? (
              <>
                <Spinner className="size-4" aria-hidden />
                Verifying…
              </>
            ) : (
              <>
                <ShieldCheck
                  className="size-4 transition-transform duration-300 group-hover/button:scale-110"
                  aria-hidden
                />
                Verify Cookie
              </>
            )}
          </Button>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary px-3.5 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {onAlive
              ? "Admin mode: cookies are processed server-side and alive sessions are saved to your private database. Click RAW / NETSCAPE / JSON to convert between formats."
              : "Cookies are processed through a secure server-side route and never stored. Click RAW / NETSCAPE / JSON to convert between formats."}
          </p>
        </div>
      </section>

      {/* Report panel */}
      <div className="flex flex-col gap-4">
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-foreground duration-300 animate-in fade-in-0 slide-in-from-top-1"
          >
            <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />
            {error}
          </div>
        )}
        {result ? (
          <ResultReport result={result} cookie={cookie} service={effectiveService} hideCookies={linksOnly} />
        ) : (
          <IdlePanel loading={loading} />
        )}
      </div>
    </div>
  )
}

// One inline diagnostic in the editor status bar: "label: value".
function Diag({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground/70">{label}:</span>
      {children}
    </span>
  )
}

// Compact ok/x flag for the status bar.
function Flag({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 font-semibold text-success">
      <CircleCheck className="size-3" aria-hidden />
      ok
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <XCircle className="size-3" aria-hidden />
      no
    </span>
  )
}

function IdlePanel({ loading }: { loading: boolean }) {
  return (
    <section className="flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border glass p-8 text-center duration-500 animate-in fade-in-0">
      <div className="flex size-16 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary">
        {loading ? (
          <Spinner className="size-6 text-primary" thickness={3} aria-hidden />
        ) : (
          <ShieldQuestion className="size-6" aria-hidden />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {loading ? "Running Diagnostics" : "No Results Yet"}
        </h3>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          {loading
            ? "Checking your cookie against the verification service…"
            : "Paste a cookie and run a verification to see the full diagnostic report here."}
        </p>
      </div>
    </section>
  )
}
