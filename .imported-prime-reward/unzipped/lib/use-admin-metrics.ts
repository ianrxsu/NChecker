"use client"

import { useCallback, useState } from "react"
import useSWR from "swr"
import type { MetricsSnapshot } from "./metrics"
import type { SystemStatus } from "./system-status"
import type { ClaimAnalytics } from "./claim-analytics"

export type AdminData = {
  metrics: MetricsSnapshot
  system: SystemStatus
  claims: ClaimAnalytics
  redisEnabled: boolean
  generatedAt: number
}

async function fetcher(url: string): Promise<AdminData> {
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (res.status === 401) {
    // Session expired — bounce to login.
    if (typeof window !== "undefined") window.location.href = "/admin/login"
    throw new Error("Unauthorized")
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

// Polls the live metrics endpoint, seeded with server-rendered data so there's
// never a loading flash. Auto-refreshes silently in the background so the panel
// feels live without ever flashing a loading state.
export function useAdminMetrics(initialData: AdminData) {
  const { data, error, mutate } = useSWR<AdminData>("/api/admin/metrics", fetcher, {
    fallbackData: initialData,
    // 60s poll aligned with the 60s server-side caches (metrics, claim analytics,
    // and the Redis ping). Every backing source is now cached for 60s, so polling
    // faster than that only burns Neon compute + Redis commands re-serving the SAME
    // cached numbers. Matching the interval to the TTL means a typical poll triggers
    // AT MOST one metrics batch + one claims batch + one ping per minute per warm
    // instance while the dashboard is open — the biggest traffic-independent drain.
    // Metrics are analytics, not realtime, so 60s is plenty live. (History: 5s
    // hammered Redis and exhausted the free-tier quota.)
    refreshInterval: 60000,
    // Do NOT poll while the tab is hidden/backgrounded. This is the single biggest
    // lever for Neon compute hours: a dashboard left open in an inactive tab stops
    // issuing queries entirely, letting Neon autosuspend. It resumes on focus.
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })

  // Only reflect a refresh in the UI when the USER explicitly asks for one.
  // Tying this to SWR's `isValidating` made the Refresh button disable + spin on
  // every background poll — a constant, ugly flicker. A user-initiated
  // refresh, by contrast, shows a brief, intentional spin.
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setIsManualRefreshing(true)
    try {
      await mutate()
    } finally {
      setIsManualRefreshing(false)
    }
  }, [mutate])

  return {
    data: data ?? initialData,
    isRefreshing: isManualRefreshing,
    error,
    refresh,
  }
}
