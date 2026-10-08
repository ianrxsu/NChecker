"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Shield, ShieldOff } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function ModeratorAccessCard() {
  const [enabled, setEnabled] = useState(true)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => { fetch("/api/admin/moderator-access").then((r) => r.ok ? r.json() : null).then((v) => v && setEnabled(v.enabled)).catch(() => {}) }, [])
  async function save(values: { enabled?: boolean; password?: string }) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/moderator-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Update failed")
      if (values.enabled !== undefined) setEnabled(values.enabled)
      if (values.password !== undefined) setPassword("")
      toast.success("Moderator access updated")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Update failed") } finally { setBusy(false) }
  }
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{enabled ? <Shield className="size-4" /> : <ShieldOff className="size-4" />} Moderator access</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-xs text-muted-foreground">Disable access to block new moderator logins and invalidate existing moderator sessions.</p>
      <div className="flex gap-2"><Button size="sm" variant={enabled ? "destructive" : "default"} disabled={busy} onClick={() => void save({ enabled: !enabled })}>{enabled ? "Disable moderator access" : "Enable moderator access"}</Button></div>
      <div className="flex flex-col gap-2 sm:flex-row"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="New moderator password" className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm" /><Button size="sm" variant="outline" disabled={busy || password.length < 8} onClick={() => void save({ password })}>Change password</Button></div>
    </CardContent>
  </Card>
}
