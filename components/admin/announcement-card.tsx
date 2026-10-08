"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function AnnouncementCard() {
  const [message, setMessage] = useState("")
  const [days, setDays] = useState("30")
  const [pending, setPending] = useState(false)

  async function request(path: string, body?: unknown) {
    setPending(true)
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "Request failed")
      toast.success(path.endsWith("/save") ? "Announcement published" : path.endsWith("/hide") ? "Announcement hidden" : "Announcement deleted")
      if (path.endsWith("/save")) setMessage("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Site announcement</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">Shown across public pages. URLs become clickable, and announcements expire automatically.</p>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} rows={4} placeholder="Write an announcement..." className="w-full resize-y border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">Duration (days)<input value={days} onChange={(event) => setDays(event.target.value)} type="number" min="1" max="3650" className="mt-1 block w-32 border border-border bg-background px-3 py-2 text-sm text-foreground" /></label>
          <Button type="button" disabled={pending || !message.trim()} onClick={() => request("/api/admin/announcement/save", { message, durationDays: Number(days) })}>{pending ? "Saving..." : "Publish"}</Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => request("/api/admin/announcement/hide")}>Hide</Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={() => request("/api/admin/announcement/delete")}>Delete</Button>
        </div>
      </CardContent>
    </Card>
  )
}
