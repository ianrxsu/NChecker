"use client"

import * as React from "react"
import { AlertDialog } from "@base-ui/react/alert-dialog"
import { TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Options accepted by the imperative confirm() function — mirrors a window.confirm
// upgrade path: pass a message, await a boolean.
export type ConfirmOptions = {
  title?: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive (red). Use for delete/clear actions. */
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = React.createContext<ConfirmFn | null>(null)

// Promise-based replacement for window.confirm(). Usage:
// const confirm = useConfirm()
// if (!(await confirm({ description: "…" }))) return
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm must be used within a <ConfirmProvider>")
  return ctx
}

// Renders a single shared AlertDialog and exposes an async confirm() through
// context, so any descendant can prompt without wiring its own modal state.
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null)
  const resolver = React.useRef<((value: boolean) => void) | null>(null)

  const confirm = React.useCallback<ConfirmFn>((options) => {
    setOpts(options)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  // Resolve the pending promise and close. Any dismissal (Esc, backdrop, Cancel)
  // resolves false; only the confirm button resolves true.
  const settle = React.useCallback((result: boolean) => {
    setOpen(false)
    resolver.current?.(result)
    resolver.current = null
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) settle(false)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-[oklch(0_0_0/0.6)] backdrop-blur-sm transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-card p-5 shadow-lg outline-none transition-all duration-150 data-[ending-style]:translate-y-[calc(-50%+4px)] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-[calc(-50%+4px)] data-[starting-style]:opacity-0">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border shadow-lg",
                  opts?.destructive ? "bg-destructive text-white" : "bg-warning text-primary-foreground",
                )}
                aria-hidden
              >
                <TriangleAlert className="size-4.5" />
              </span>
              <div className="flex flex-col gap-1.5">
                <AlertDialog.Title className="text-base font-semibold uppercase tracking-wide text-foreground">
                  {opts?.title ?? "Are you sure?"}
                </AlertDialog.Title>
                <AlertDialog.Description className="text-sm leading-relaxed text-muted-foreground">
                  {opts?.description}
                </AlertDialog.Description>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => settle(false)}>
                {opts?.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                type="button"
                variant={opts?.destructive ? "destructive" : "default"}
                size="sm"
                onClick={() => settle(true)}
                autoFocus
              >
                {opts?.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  )
}
