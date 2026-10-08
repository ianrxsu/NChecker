"use client"

import { Loader2, KeyRound } from "lucide-react"
import { useFormStatus } from "react-dom"

export function RedeemCodeButton() {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex min-h-11 items-center justify-center gap-2 border border-foreground bg-primary px-5 text-xs font-bold uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
      {pending ? "Checking code…" : "Redeem code"}
    </button>
  )
}
