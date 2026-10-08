"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Eraser } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

type ResetResponse = {
  ok: boolean
  ip: string
  hasDeviceId: boolean
  clearedClaimKeys: number
  clearedCooldown: boolean
}

// Admin testing aid. Clears every per-visitor limit that applies to the ADMIN'S OWN
// device/IP — the per-service claim buckets (IP + device), the ShrinkEarn 24h
// cooldown, and the browser "already received" cookies — so the admin can run the
// account generator repeatedly while testing. Scoped strictly to the caller: it
// cannot touch another visitor's limits or any global data.
export function ResetMyLimitsCard() {
  const [running, setRunning] = useState(false)

  async function handleReset() {
    setRunning(true)
    try {
      const res = await fetch("/api/admin/reset-my-limits", { method: "POST" })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data: ResetResponse = await res.json()
      toast.success("Your limits were reset", {
        description: `Cleared ${data.clearedClaimKeys} claim bucket(s)${
          data.clearedCooldown ? " + ShrinkEarn cooldown" : ""
        } for ${data.ip}. You can claim again now.`,
      })
    } catch (err) {
      toast.error("Could not reset your limits", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Eraser className="size-4 text-muted-foreground" aria-hidden />
          Reset my limits (testing)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Clears the account-claim limits tied to <span className="font-semibold text-foreground">your own</span> IP and
          device (website <span className="font-semibold text-foreground">and</span> any browser-extension installs that
          claimed from your IP), your ShrinkEarn 24h cooldown, and your &ldquo;already received&rdquo; history — so you
          can run the generator repeatedly while testing. This only affects the device you&apos;re on right now; other
          visitors are untouched.
        </p>

        <div className="flex items-center justify-end">
          <Button size="sm" variant="destructive" onClick={handleReset} disabled={running}>
            <Eraser className="size-4" aria-hidden />
            {running ? "Resetting…" : "Reset my limits"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
