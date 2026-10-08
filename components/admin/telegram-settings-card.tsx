"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function TelegramSettingsCard() {
  const [secret, setSecret] = useState("")
  const [configured, setConfigured] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const response = await fetch("/api/admin/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not save secret.")
      setConfigured(true)
      setSecret("")
      toast.success("Telegram webhook secret saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save secret.")
    } finally { setSaving(false) }
  }

  async function clear() {
    await fetch("/api/admin/telegram", { method: "DELETE" })
    setConfigured(false)
    toast.success("Telegram webhook secret cleared")
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Telegram webhook</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">Set a private secret, then use the same value in Telegram&apos;s setWebhook URL.</p>
        <label className="sr-only" htmlFor="telegram-webhook-secret">Telegram webhook secret</label>
        <input id="telegram-webhook-secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={configured ? "Configured — enter a new secret to replace it" : "Minimum 32 characters"} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" autoComplete="new-password" />
        <div className="flex gap-2">
          <Button type="button" onClick={save} disabled={saving || secret.trim().length < 32}>{saving ? "Saving…" : "Save secret"}</Button>
          {configured && <Button type="button" variant="outline" onClick={clear}>Clear</Button>}
        </div>
      </CardContent>
    </Card>
  )
}
