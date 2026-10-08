"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

// Route-level error boundary for the entire /admin tree. If a server render or
// data fetch throws, this renders a recoverable screen (with a reset) instead of
// the bare framework "This page couldn't load" page.
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.log("[v0] admin route error:", error?.message, error?.digest)
  }, [error])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="flex size-14 items-center justify-center border border-border bg-card">
        <AlertTriangle className="size-7 text-foreground" aria-hidden />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold uppercase tracking-widest text-foreground text-balance">
          Admin panel hit an error
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
          Something went wrong while loading this view. This is usually transient — try again, and if it keeps happening
          check the System section for service status.
        </p>
        {error?.digest && <p className="mt-1 font-mono text-xs text-muted-foreground">Ref: {error.digest}</p>}
      </div>
      <Button onClick={reset} className="font-bold uppercase tracking-wider">
        Try again
      </Button>
    </main>
  )
}
