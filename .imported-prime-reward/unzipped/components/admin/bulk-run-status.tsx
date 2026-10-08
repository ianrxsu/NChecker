"use client"

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

// Live snapshot of the embedded bulk checker's run, lifted out of the Checker tab
// so the admin header can show a global status pill from ANY tab. The checker stays
// mounted across tab switches, so it keeps pushing updates here while you browse.
export type BulkRunStatus = {
  running: boolean
  paused: boolean
  preparing: boolean
  total: number
  done: number
  alive: number
  dead: number
  error: number
  progress: number
}

const EMPTY: BulkRunStatus = {
  running: false,
  paused: false,
  preparing: false,
  total: 0,
  done: 0,
  alive: 0,
  dead: 0,
  error: 0,
  progress: 0,
}

// `active` means there is a run worth surfacing in the header: it's running,
// preparing proxies, or paused mid-way with work still left to finish.
function isActive(s: BulkRunStatus): boolean {
  return s.running || s.preparing || (s.paused && s.done < s.total && s.total > 0)
}

const Ctx = createContext<{
  status: BulkRunStatus
  active: boolean
  setStatus: (s: BulkRunStatus) => void
}>({ status: EMPTY, active: false, setStatus: () => {} })

export function BulkRunStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BulkRunStatus>(EMPTY)
  const value = useMemo(() => ({ status, active: isActive(status), setStatus }), [status])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useBulkRunStatus() {
  return useContext(Ctx)
}
