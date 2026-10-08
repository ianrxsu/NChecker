"use client"

import { ArrowRight, Loader2 } from "lucide-react"
import { useState } from "react"

export function UnlockLinkButton({ href, label }: { href: string; label: string }) {
  const [pending, setPending] = useState(false)

  return (
    <button type="button" disabled={pending} onClick={() => { setPending(true); window.location.assign(href) }} aria-busy={pending} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 bg-primary px-4 text-sm font-semibold uppercase tracking-widest text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70">
      {pending ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Loading…</> : <>{label} <ArrowRight className="size-4" aria-hidden /></>}
    </button>
  )
}
