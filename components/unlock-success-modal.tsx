"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, X } from "lucide-react"

export function UnlockSuccessModal({ active }: { active: boolean }) {
  const [open, setOpen] = useState(active)

  useEffect(() => {
    if (!active) return
    window.history.replaceState({}, "", window.location.pathname)
  }, [active])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="unlock-success-title">
      <div className="w-full max-w-md border border-accent bg-card p-6 shadow-2xl">
        <div className="flex items-center gap-3 text-accent"><CheckCircle2 className="size-6" aria-hidden /><span className="text-xs font-semibold uppercase tracking-widest">Unlock successful</span></div>
        <h2 id="unlock-success-title" className="mt-5 text-2xl font-semibold uppercase tracking-tight">24-hour access unlocked</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Your access pass is active. You can now generate accounts without repeating the verification steps.</p>
        <button type="button" onClick={() => setOpen(false)} className="mt-6 flex min-h-11 w-full items-center justify-center gap-2 bg-primary px-5 text-sm font-semibold uppercase tracking-widest text-primary-foreground hover:opacity-90">Continue <X className="size-4" aria-hidden /></button>
      </div>
    </div>
  )
}
