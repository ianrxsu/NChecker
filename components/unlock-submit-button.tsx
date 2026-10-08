"use client"

import { Loader2, ShieldCheck } from "lucide-react"
import { useFormStatus } from "react-dom"

// Submit button for the unlock <form>. Lives in its own client component so it can read
// useFormStatus() — the parent page is a server component and the startUnlock action is
// slow (it mints a session and calls the gateway/ShrinkEarn API before redirecting), so
// without this the button looked frozen with no feedback. While pending we swap in a
// spinner, disable the button (blocks double submits), and dim it.
export function UnlockSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex w-full items-center justify-center gap-2 border border-border bg-primary px-6 py-4 text-sm font-semibold uppercase tracking-widest text-primary-foreground shadow-lg transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? (
        <>
          <Loader2 className="size-5 animate-spin" aria-hidden />
          Preparing your checker access…
        </>
      ) : (
        <>
          <ShieldCheck className="size-5" aria-hidden />
          Unlock 24-hour access
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {pending ? `Preparing your ${label} checker access` : ""}
      </span>
    </button>
  )
}
