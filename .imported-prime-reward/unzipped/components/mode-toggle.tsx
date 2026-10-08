"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"

// Compact light/dark switcher used in the site header. Renders a neutral
// placeholder until mounted to avoid a hydration mismatch (the resolved theme
// is only known on the client).
export function ModeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme === "dark"
  // Until mounted, the resolved theme is unknown — keep a stable, theme-agnostic
  // label so the server and first client render match (no hydration mismatch).
  const label = !mounted ? "Toggle color theme" : isDark ? "Switch to light mode" : "Switch to dark mode"

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
      title={label}
      className={`press inline-flex size-9 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground ${className}`}
    >
      {mounted ? (
        isDark ? (
          <Sun className="size-4" aria-hidden />
        ) : (
          <Moon className="size-4" aria-hidden />
        )
      ) : (
        <Sun className="size-4 opacity-0" aria-hidden />
      )}
    </button>
  )
}
