"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Search } from "lucide-react"
import { cn } from "@/lib/utils"

export type SelectOption = {
  value: string
  // Primary text shown in the trigger and as the main option label.
  label: string
  // Optional trailing hint (e.g. an account count) shown muted.
  hint?: string
  // Optional leading node (icon, flag, badge).
  leading?: React.ReactNode
  disabled?: boolean
  // Extra text matched against the search query (in addition to label).
  keywords?: string
}

// A global, theme-aligned dropdown (custom listbox) that replaces the native
// <select>. It matches the neo-brutalist styling used across the app (2px borders,
// hard shadows, mono/heading type) and supports an optional type-to-filter search,
// full keyboard navigation, and click-outside / Escape to close.
export function SelectDropdown({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchable = false,
  searchPlaceholder = "Search…",
  leading,
  ariaLabel,
  className,
  contentClassName,
}: {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchable?: boolean
  searchPlaceholder?: string
  // Leading node shown in the trigger (e.g. a Globe icon).
  leading?: React.ReactNode
  ariaLabel?: string
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()

  const selected = options.find((o) => o.value === value) ?? null

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options
    const q = query.trim().toLowerCase()
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.keywords ?? "").toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q),
    )
  }, [options, query, searchable])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  // When opening, focus the search (if any) and align the active row to the
  // current selection.
  useEffect(() => {
    if (!open) {
      setQuery("")
      return
    }
    const idx = Math.max(
      0,
      filtered.findIndex((o) => o.value === value),
    )
    setActiveIndex(idx)
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Reset the active row when the filtered set changes.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, open])

  function commit(opt: SelectOption | undefined) {
    if (!opt || opt.disabled) return
    onChange(opt.value)
    setOpen(false)
  }

  function moveActive(delta: number) {
    if (filtered.length === 0) return
    let next = activeIndex
    for (let i = 0; i < filtered.length; i++) {
      next = (next + delta + filtered.length) % filtered.length
      if (!filtered[next]?.disabled) break
    }
    setActiveIndex(next)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        moveActive(1)
        break
      case "ArrowUp":
        e.preventDefault()
        moveActive(-1)
        break
      case "Enter":
        e.preventDefault()
        commit(filtered[activeIndex])
        break
      case "Escape":
        e.preventDefault()
        setOpen(false)
        break
      case "Tab":
        setOpen(false)
        break
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-card py-3 pl-3 pr-3 text-left font-mono text-sm font-bold uppercase tracking-wide text-foreground outline-none transition-all hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {leading && <span className="shrink-0 text-muted-foreground">{leading}</span>}
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.label : placeholder}
        </span>
        {selected?.hint && <span className="shrink-0 text-muted-foreground">{selected.hint}</span>}
        <ChevronDown
          className={cn("size-4 shrink-0 text-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 mt-2 overflow-hidden rounded-md border border-border bg-popover shadow-[var(--tc-shadow)]",
            contentClassName,
          )}
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent font-mono text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          <ul
            ref={listRef}
            role="listbox"
            id={listboxId}
            aria-label={ariaLabel}
            className="max-h-72 overflow-y-auto py-1"
          >
            {filtered.length === 0 && (
              <li className="px-3 py-3 font-mono text-sm font-bold text-muted-foreground">No matches.</li>
            )}
            {filtered.map((opt, i) => {
              const isSelected = opt.value === value
              const isActive = i === activeIndex
              return (
                <li key={opt.value} role="option" aria-selected={isSelected} data-index={i}>
                  <button
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => commit(opt)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2.5 text-left font-mono text-sm font-bold uppercase tracking-wide transition-colors",
                      isActive ? "bg-primary text-primary-foreground" : "text-foreground",
                      opt.disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    {opt.leading && <span className="shrink-0">{opt.leading}</span>}
                    <span className="flex-1 truncate normal-case">{opt.label}</span>
                    {opt.hint && (
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          isActive ? "text-primary-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {opt.hint}
                      </span>
                    )}
                    {isSelected && <Check className="size-4 shrink-0" aria-hidden />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
