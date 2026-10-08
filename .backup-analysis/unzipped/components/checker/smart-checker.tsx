"use client"

import { useCallback, useMemo, useState } from "react"
import { Sparkles, User, Layers, ScanSearch } from "lucide-react"
import { SingleChecker } from "@/components/checker/single-checker"
import { BulkChecker } from "@/components/checker/bulk-checker"
import type { CheckerService } from "@/lib/checker-visibility"

type Mode = "single" | "bulk"
// "auto" is only meaningful for single checks (per product decision); bulk always
// uses a concretely-selected service.
type Selected = "auto" | CheckerService

const SERVICE_LABELS: Record<CheckerService, string> = {
  netflix: "Netflix",
  prime: "Prime",
  crunchyroll: "Crunchyroll",
}

// The unified, admin-gated "all-in-one" checker at /checker. It composes the
// existing SingleChecker / BulkChecker (nothing about the classic per-service pages
// changes) and adds:
//   • Auto-detect for single checks — infers Netflix/Prime/Crunchyroll from the
//     pasted cookie so visitors don't have to know which site it's for.
//   • Manual service selection — for bulk (which requires one service) or whenever
//     a visitor prefers to force a specific service.
//
// `services` is the set of services the admin currently allows publicly, and
// `bulkServices` is the subset whose bulk mode is also allowed. Both are resolved
// on the server so hidden services never appear here.
export function SmartChecker({
  services,
  bulkServices,
  linksOnly = false,
}: {
  services: CheckerService[]
  bulkServices: CheckerService[]
  linksOnly?: boolean
}) {
  const bulkAvailable = bulkServices.length > 0

  const [mode, setMode] = useState<Mode>("single")
  const [selected, setSelected] = useState<Selected>("auto")
  // Reflects what auto-detect inferred from the current single-cookie input, purely
  // for the "Detected: …" hint. null = nothing recognizable pasted yet.
  const [detected, setDetected] = useState<CheckerService | null>(null)

  const onDetect = useCallback((svc: CheckerService | null) => setDetected(svc), [])

  // Switching to bulk forces a concrete service (auto isn't allowed there). If the
  // current selection can't do bulk, jump to the first bulk-capable service.
  const selectMode = useCallback(
    (next: Mode) => {
      if (next === "bulk") {
        const canBulk = selected !== "auto" && bulkServices.includes(selected)
        if (!canBulk) setSelected(bulkServices[0] ?? "auto")
      }
      setMode(next)
    },
    [selected, bulkServices],
  )

  function selectService(next: Selected) {
    // Guard: never allow "auto" or a non-bulk service to be active in bulk mode.
    if (mode === "bulk" && (next === "auto" || !bulkServices.includes(next))) return
    setSelected(next)
  }

  // The concrete service handed to the child checker. In single-auto we pass
  // autoDetect and let SingleChecker infer; otherwise it's the picked service.
  const isAuto = selected === "auto"
  const concreteService: CheckerService = isAuto ? detected ?? "netflix" : selected

  const chips: Selected[] = useMemo(() => ["auto", ...services], [services])

  return (
    <div className="flex flex-col gap-5">
      {/* Mode tabs (single / bulk) — bulk only shown when the admin allows it for at
          least one service. */}
      {bulkAvailable && (
        <div
          role="tablist"
          aria-label="Checker mode"
          className="inline-flex w-full max-w-xs items-center gap-1 rounded-lg glass p-1.5"
        >
          <TabButton active={mode === "single"} onClick={() => selectMode("single")} icon={User} label="single" />
          <TabButton active={mode === "bulk"} onClick={() => selectMode("bulk")} icon={Layers} label="bulk" />
        </div>
      )}

      {/* Service selector */}
      <div className="flex flex-col gap-2 rounded-lg glass p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            <ScanSearch className="size-3.5 text-primary" aria-hidden />
            Service
          </span>
          {chips.map((c) => {
            const isAutoChip = c === "auto"
            // Auto is disabled in bulk; a service is disabled in bulk if it can't bulk.
            const disabled =
              mode === "bulk" && (isAutoChip || !bulkServices.includes(c as CheckerService))
            const active = selected === c
            const label = isAutoChip ? "Auto-detect" : SERVICE_LABELS[c as CheckerService]
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => selectService(c)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold tracking-widest transition-all duration-75 disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "border-primary bg-primary text-primary-foreground shadow-lg"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {isAutoChip && <Sparkles className="size-3.5" aria-hidden />}
                {label}
              </button>
            )
          })}
        </div>

        {/* Contextual hint */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {mode === "bulk" ? (
            <>Bulk checks run against one service — <span className="text-foreground">{SERVICE_LABELS[concreteService]}</span>. Pick a different service above to switch.</>
          ) : isAuto ? (
            detected ? (
              <>
                Detected <span className="font-semibold text-primary">{SERVICE_LABELS[detected]}</span> from your
                cookie. Paste any Netflix, Prime, or Crunchyroll cookie — we&apos;ll route it automatically.
              </>
            ) : (
              <>Auto-detect on. Paste any Netflix, Prime, or Crunchyroll cookie and we&apos;ll figure out the service.</>
            )
          ) : (
            <>Checking against <span className="text-foreground">{SERVICE_LABELS[concreteService]}</span>.</>
          )}
        </p>
      </div>

      {/* Single checker */}
      <div className={mode === "single" ? "animate-in fade-in-0 slide-in-from-bottom-1 duration-300" : "hidden"}>
        <SingleChecker
          // Remount when switching between auto and a fixed service so internal
          // detection state stays consistent with the selector.
          key={isAuto ? "auto" : `fixed-${selected}`}
          service={concreteService}
          autoDetect={isAuto}
          allowedServices={services}
          onDetect={onDetect}
        />
      </div>

      {/* Bulk checker — only rendered when allowed AND in bulk mode. Keyed by service
          so switching services gives a clean bulk session (and namespaced storage). */}
      {bulkAvailable && mode === "bulk" && !isAuto && (
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
          <BulkChecker
            key={`bulk-${selected}`}
            service={selected}
            storageKey={`smart-${selected}`}
          />
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof User
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`press inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm tracking-widest transition-all duration-150 ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  )
}
