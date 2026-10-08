"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Lock, Loader2 } from "lucide-react"

export function AdminLoginForm({ configured }: { configured: boolean }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setError("")
    setLoading(true)
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
      if (res.ok && data?.ok) {
        router.replace("/admin")
        router.refresh()
        return
      }
      setError(data?.message || "Login failed.")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-md glass p-7" aria-describedby={error ? "login-error" : undefined}>
      <label
        htmlFor="admin-password"
        className="mb-2 block text-xs font-semibold uppercase tracking-widest text-muted-foreground"
      >
        Password
      </label>
      <div className="relative">
        <Lock
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading || !configured}
          className="h-11 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:opacity-60"
          placeholder="••••••••••"
        />
      </div>

      {error && (
        <p id="login-error" role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {!configured && (
        <p className="mt-3 text-sm text-warning">
          Admin is not configured. Set the ADMIN_PASSWORD environment variable.
        </p>
      )}

      <Button type="submit" className="mt-5 h-11 w-full" disabled={loading || !configured || password.length === 0}>
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}
        {loading ? "Verifying…" : "Unlock dashboard"}
      </Button>
    </form>
  )
}
