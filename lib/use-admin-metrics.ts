"use client"

import { useCallback, useState } from "react"
import useSWR from "swr"
import type { MetricsSnapshot } from "./metrics"
import type { SystemStatus } from "./system-status"
import type { ClaimAnalytics } from "./claim-analytics"
import type { DailyCompletionStats } from "./daily-completion-stats"

export type AdminData = {
  metrics: MetricsSnapshot
  system: SystemStatus
  claims: ClaimAnalytics
  dailyCompletions: DailyCompletionStats
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

// Seed from the server and refresh on demand: a dashboard left open must not
// keep waking the database or invoking functions when nobody needs new metrics.
export function useAdminMetrics(initialData: AdminData) {
  const { data, error, mutate } = useSWR<AdminData>("/api/admin/metrics", fetcher, {
    fallbackData: initialData,
    refreshInterval: 0,
    revalidateOnMount: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
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
