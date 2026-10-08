"use client"

import { useEffect, useState } from "react"

// True only after the first client render. Use to gate time-relative values
// (relative timestamps, locale clocks) that would otherwise differ between the
// server-rendered HTML and the client, causing hydration mismatches.
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
