"use client"

import { useState } from "react"
import { toast } from "sonner"
import { RotateCcw, Trash2, ChevronDown, ShieldCheck, ShieldAlert, ShieldQuestion, Mail } from "lucide-react"
import { ConfirmProvider, useConfirm } from "@/components/ui/confirm-dialog"
import { Spinner } from "@/components/ui/spinner"
import { ResultReport } from "@/components/checker/result-report"
import { countryName } from "@/lib/country-names"
import {
  recheckClaimedAccount,
  deleteClaimedAccount,
  type ClaimedStatus,
} from "@/app/account-generator/claimed-actions"
import type { GrantedAccount } from "@/lib/granted-account"
import { cn } from "@/lib/utils"

// "Your accounts" — the history of accounts THIS visitor has claimed (persisted in
// their browser cookie). Each can be re-verified live (alive/dead) or removed.
// Removing always drops it from the visitor's list; if it has expired, it's also
// purged from the shared database.
export function ClaimedAccounts({
  initial,
  service = "netflix",
  hideCookies = false,
}: {
  initial: GrantedAccount[]
  service?: "netflix" | "prime" | "crunchyroll"
  // When true, cookie copy actions are hidden from rechecker results (Netflix only).
  hideCookies?: boolean
}) {
  if (initial.length === 0) return null
  return (
    <ConfirmProvider>
      <ClaimedAccountsInner initial={initial} service={service} hideCookies={hideCookies} />
    </ConfirmProvider>
  )
}

type Busy = "recheck" | "delete" | undefined

function ClaimedAccountsInner({
  initial,
  service,
  hideCookies,
}: {
  initial: GrantedAccount[]
  service: "netflix" | "prime" | "crunchyroll"
  hideCookies: boolean
}) {
  const confirm = useConfirm()
  const [accounts, setAccounts] = useState<GrantedAccount[]>(initial)
  const [statuses, setStatuses] = useState<Record<string, ClaimedStatus>>({})
  const [busy, setBusy] = useState<Record<string, Busy>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  if (accounts.length === 0) return null

  async function handleRecheck(id: string) {
    setBusy((b) => ({ ...b, [id]: "recheck" }))
    try {
      const { status } = await recheckClaimedAccount(id, service)
      setStatuses((s) => ({ ...s, [id]: status }))
      if (status === "alive") toast.success("Still alive — this account works.")
      else if (status === "dead") toast.error("Expired — removed from the pool. You can delete it from your list.")
      else toast.message("Couldn't verify right now. Please try again in a moment.")
    } catch {
      toast.error("Recheck failed. Please try again.")
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }))
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Remove this account?",
      description:
        "It will be removed from your list. If the account has already expired, it will also be deleted from the pool.",
      confirmLabel: "Remove",
      destructive: true,
    })
    if (!ok) return
    setBusy((b) => ({ ...b, [id]: "delete" }))
    try {
      const { removedFromDb } = await deleteClaimedAccount(id, service)
      setAccounts((a) => a.filter((x) => x.id !== id))
      toast.success(removedFromDb ? "Expired account deleted from the pool." : "Removed from your list.")
    } catch {
      toast.error("Couldn't remove the account. Please try again.")
      setBusy((b) => ({ ...b, [id]: undefined }))
    }
  }

  return (
    <section className="mt-10 flex flex-col gap-4" aria-label="Your claimed accounts">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center bg-primary text-xs font-semibold text-primary-foreground">
          {accounts.length}
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-foreground">Your accounts</h2>
      </div>
      <p className="-mt-2 text-xs font-medium text-muted-foreground">
        Accounts you&apos;ve claimed on this device. Recheck to confirm they&apos;re still alive, or remove ones you
        don&apos;t need.
      </p>

      <ul className="flex flex-col gap-3">
        {accounts.map((account) => {
          const status = statuses[account.id]
          const isBusy = busy[account.id]
          const isOpen = expanded === account.id
          const country = account.result.countryCode ? countryName(account.result.countryCode) : null

          return (
            <li key={account.id} className="border border-border bg-card shadow-lg">
              {/* Summary row */}
              <div className="flex flex-wrap items-center gap-3 p-4">
                <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-sm font-bold text-foreground">
                    {account.result.email ??
                      (service === "prime"
                        ? "Prime account"
                        : service === "crunchyroll"
                          ? "Crunchyroll account"
                          : "Netflix account")}
                  </span>
                  <span className="truncate text-xs font-medium text-muted-foreground">
                    {[account.result.plan, country].filter(Boolean).join(" · ") || "Details below"}
                  </span>
                </div>

                <StatusBadge status={status} />

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRecheck(account.id)}
                    disabled={!!isBusy}
                    className="inline-flex items-center gap-1.5 border border-border bg-card px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground shadow-lg transition-all disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBusy === "recheck" ? (
                      <Spinner className="size-3.5" thickness={3} />
                    ) : (
                      <RotateCcw className="size-3.5" aria-hidden />
                    )}
                    Recheck
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(account.id)}
                    disabled={!!isBusy}
                    aria-label="Remove account"
                    className="inline-flex items-center gap-1.5 border border-border bg-destructive px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-destructive-foreground shadow-lg transition-all disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBusy === "delete" ? (
                      <Spinner className="size-3.5" thickness={3} />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : account.id)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Hide details" : "Show details"}
                    className="inline-flex size-8 items-center justify-center border border-border bg-card text-foreground shadow-lg transition-all "
                  >
                    <ChevronDown className={cn("size-4 transition-transform", isOpen && "rotate-180")} aria-hidden />
                  </button>
                </div>
              </div>

              {/* Expanded full details */}
              {isOpen && (
                <div className="border-t border-border p-4">
                  <ResultReport cookie={account.cookie} result={account.result} service={service} hideCookies={hideCookies} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function StatusBadge({ status }: { status: ClaimedStatus | undefined }) {
  const map = {
    alive: { label: "Alive", cls: "bg-success text-success-foreground", Icon: ShieldCheck },
    dead: { label: "Expired", cls: "bg-destructive text-destructive-foreground", Icon: ShieldAlert },
    unknown: { label: "Unverified", cls: "bg-warning text-foreground", Icon: ShieldQuestion },
  } as const
  const cfg = status ? map[status] : null
  if (!cfg) {
    return (
      <span className="inline-flex items-center gap-1.5 border border-border bg-muted px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Not checked
      </span>
    )
  }
  const { label, cls, Icon } = cfg
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest",
        cls,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  )
}
