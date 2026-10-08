"use client"

import { useFormStatus } from "react-dom"

export function LifetimeKeyLoginButton() {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="min-h-11 bg-secondary px-4 text-sm font-semibold text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Signing in..." : "Sign in with lifetime key"}
    </button>
  )
}
