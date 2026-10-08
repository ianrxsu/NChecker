"use client"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function PublicAccessCard() {
  const [password, setPassword] = useState("")
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/admin/public-access?t=${Date.now()}`, { cache: "no-store", headers: { "cache-control": "no-cache" } }).then((res) => res.ok ? res.json() : null).then((data) => {
      if (data && typeof data.enabled === "boolean") setEnabled(data.enabled)
    }).catch(() => undefined)
  }, [])

  async function toggle(next: boolean) {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/public-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next }) })
      if (!res.ok) throw new Error("Could not update public access gate")
      setEnabled(next)
      toast.success(next ? "Public password gate enabled" : "Public password gate disabled")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not update public access gate") } finally { setSaving(false) }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/public-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) })
      if (!res.ok) throw new Error("Could not update password")
      setPassword("")
      toast.success("Public access password changed")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not update password") } finally { setSaving(false) }
  }

  return <Card><CardHeader><CardTitle className="text-sm">Public access gate</CardTitle></CardHeader><CardContent className="space-y-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Password protection</p><p className="text-xs text-muted-foreground">{enabled ? "Visitors must enter the password." : "Public access is open."}</p></div><button type="button" disabled={saving} onClick={() => toggle(!enabled)} className="bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">{enabled ? "Turn Off" : "Turn On"}</button></div><p className="text-xs leading-relaxed text-muted-foreground">Each unlock lasts 2 days. Share the password through the Telegram group.</p><div className="flex gap-2"><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="New public password" className="min-h-10 flex-1 border border-border bg-background px-3 text-sm" /><button disabled={saving || password.length < 8} onClick={save} className="bg-primary px-4 text-sm font-semibold text-primary-foreground">Change</button></div></CardContent></Card>
}
