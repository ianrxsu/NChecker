"use client"

import { useEffect, useState } from "react"

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`
}

export function AccessPassCountdown({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))

  useEffect(() => {
    const update = () => setRemaining(Math.max(0, expiresAt - Date.now()))
    update()
    const interval = window.setInterval(update, 1000)
    return () => window.clearInterval(interval)
  }, [expiresAt])

  const expired = remaining <= 0

  return (
    <p className="border border-accent/40 bg-accent/10 px-4 py-3 text-xs font-medium leading-relaxed text-foreground" role="status">
      {expired ? "Access is locked again. Refresh to unlock another 24-hour session." : `Access is active for this browser. Locks again in ${formatRemaining(remaining)}.`}
    </p>
  )
}
