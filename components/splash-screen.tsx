"use client"

import { useEffect, useRef, useState } from "react"
import { TerminalSquare } from "lucide-react"

const BOOT_LINES = [
  "> initializing secure runtime…",
  "> loading cookie diagnostics core…",
  "> verifying integrity checks…",
  "> mounting interface…",
]

// Only show the boot splash the first time per browser session.
const SESSION_KEY = "cookie-diag:booted"

export function SplashScreen() {
  // Start hidden during SSR; decide on mount to avoid a flash for returning users.
  const [show, setShow] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [progress, setProgress] = useState(0)
  const [lineCount, setLineCount] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    if (typeof window === "undefined") return

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let alreadyBooted = false
    try {
      alreadyBooted = sessionStorage.getItem(SESSION_KEY) === "1"
    } catch {
      // sessionStorage may be unavailable (privacy mode); fall back to showing once.
    }

    if (alreadyBooted) return

    setShow(true)
    document.body.style.overflow = "hidden"

    const push = (fn: () => void, delay: number) => {
      timers.current.push(setTimeout(fn, delay))
    }

    // Reveal boot lines in sequence.
    BOOT_LINES.forEach((_, i) => push(() => setLineCount(i + 1), 220 + i * 240))

    // Smoothly drive the progress bar to 100%.
    const tick = () => {
      setProgress((p) => {
        const next = Math.min(100, p + Math.random() * 16 + 6)
        if (next < 100) push(tick, reduceMotion ? 30 : 110)
        return next
      })
    }
    push(tick, 260)

    // Dismiss once loaded (and after a short minimum so it doesn't flicker).
    const minDelay = reduceMotion ? 200 : 1400
    const dismiss = () => {
      push(() => setLeaving(true), 0)
      push(() => {
        setShow(false)
        document.body.style.overflow = ""
        try {
          sessionStorage.setItem(SESSION_KEY, "1")
        } catch {
          /* ignore */
        }
      }, 480)
    }

    const start = Date.now()
    const onReady = () => {
      const elapsed = Date.now() - start
      push(dismiss, Math.max(0, minDelay - elapsed))
    }

    if (document.readyState === "complete") {
      onReady()
    } else {
      window.addEventListener("load", onReady, { once: true })
      // Safety net so we never trap the user if `load` never fires.
      push(onReady, 6000)
    }

    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
      window.removeEventListener("load", onReady)
      document.body.style.overflow = ""
    }
  }, [])

  if (!show) return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading Cookie Diagnostics"
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity duration-500 ease-out ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div className="glow-cyan relative flex w-full max-w-md flex-col overflow-hidden glass">
        {/* Terminal window chrome */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="size-3 rounded-full bg-destructive/80" aria-hidden />
          <span className="size-3 rounded-full bg-muted-foreground/40" aria-hidden />
          <span className="size-3 rounded-full bg-primary/80" aria-hidden />
          <span className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
            <TerminalSquare className="size-3.5 text-primary" aria-hidden />
            cookies-mo — boot
          </span>
        </div>

        <div className="flex flex-col gap-6 p-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
              <TerminalSquare className="size-6" aria-hidden />
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold tracking-tight text-foreground text-balance">Cookies Mo</h1>
              <p className="text-xs tracking-wide text-muted-foreground">session verification</p>
            </div>
          </div>

          {/* Boot log */}
          <div className="min-h-[96px] rounded-md glass-subtle p-4 text-left text-xs leading-relaxed">
            {BOOT_LINES.slice(0, lineCount).map((line, i) => (
              <div
                key={line}
                className="flex items-center gap-2 text-muted-foreground duration-300 animate-in fade-in-0 slide-in-from-left-1"
              >
                <span className="text-foreground">{line}</span>
                {i === lineCount - 1 && progress < 100 && (
                  <span className="tc-blink inline-block h-3 w-1.5 bg-primary" aria-hidden />
                )}
                {i < lineCount - 1 || progress >= 100 ? (
                  <span className="ml-auto font-semibold uppercase text-primary">200 ok</span>
                ) : null}
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div className="flex flex-col gap-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
              <span>loading</span>
              <span className="text-foreground">{Math.round(progress)}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
