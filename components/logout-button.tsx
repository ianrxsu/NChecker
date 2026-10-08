"use client"

import { useState } from "react"

export function LogoutButton() {
  const [loading, setLoading] = useState(false)

  function handleLogout() {
    if (loading) return
    setLoading(true)
    window.location.assign("/api/logout")
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
    >
      {loading ? "Logging out" : "Log out"}
    </button>
  )
}
