"use client"

import { useState } from "react"

export function LifetimeKeyLoginButton() {
  const [cooldown, setCooldown] = useState(0)

  function handleClick() {
    setCooldown(5)
    const timer = window.setInterval(() => {
      setCooldown((value) => {
        if (value <= 1) {
          window.clearInterval(timer)
          return 0
        }
        return value - 1
      })
    }, 1000)
  }

  return (
    <button
      type="submit"
      disabled={cooldown > 0}
      onClick={handleClick}
      className="min-h-11 bg-secondary px-4 text-sm font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
    >
      {cooldown > 0 ? `Try again in ${cooldown}s` : "Sign in with lifetime key"}
    </button>
  )
}
