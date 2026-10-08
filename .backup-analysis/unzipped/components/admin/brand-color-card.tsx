"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2, Palette, RotateCcw, Save, Check } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BRAND_PRESETS, DEFAULT_BRAND_COLOR, normalizeHex, brandCssVars } from "@/lib/brand-color-utils"
import { StatusDot } from "./shared"

// Applies (or clears) the brand CSS variables on the document root so the whole
// panel — and the live preview swatches — recolor instantly as you pick. On save
// the server persists the value and re-injects it on the next load; on reset we
// strip the inline overrides so the built-in defaults return.
function applyPreview(hex: string | null) {
  const root = document.documentElement
  const vars = brandCssVars(DEFAULT_BRAND_COLOR)
  if (hex) {
    for (const [k, v] of Object.entries(brandCssVars(hex))) root.style.setProperty(k, v)
  } else {
    for (const k of Object.keys(vars)) root.style.removeProperty(k)
  }
}

// Force the browser to re-request the (dynamic) favicon after a color change.
function refreshFavicon() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = `/api/icon?v=${Date.now()}`
}

// Admin control for the site's dynamic MAIN color. Recolors every primary/accent
// token, glows, the logo tile and the favicon across the whole app.
export function BrandColorCard() {
  const [saved, setSaved] = useState<string>(DEFAULT_BRAND_COLOR)
  const [draft, setDraft] = useState<string>(DEFAULT_BRAND_COLOR)
  const [hexInput, setHexInput] = useState<string>(DEFAULT_BRAND_COLOR)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const previewing = useRef(false)

  // Load the current color on mount.
  useEffect(() => {
    let active = true
    fetch("/api/admin/brand-color")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { color?: string } | null) => {
        if (!active) return
        const color = normalizeHex(data?.color) ?? DEFAULT_BRAND_COLOR
        setSaved(color)
        setDraft(color)
        setHexInput(color)
      })
      .catch(() => {})
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  // Keep the live preview in sync with the draft; strip overrides on unmount.
  useEffect(() => {
    applyPreview(draft)
    previewing.current = true
    return () => {
      if (previewing.current) applyPreview(null)
    }
  }, [draft])

  function pick(hex: string) {
    const norm = normalizeHex(hex)
    if (!norm) return
    setDraft(norm)
    setHexInput(norm)
  }

  const dirty = draft !== saved
  const isDefault = draft === DEFAULT_BRAND_COLOR

  async function persist(color: string | null) {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/brand-color", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        throw new Error(msg?.error ?? `Request failed (${res.status})`)
      }
      const next: { color: string } = await res.json()
      const norm = normalizeHex(next.color) ?? DEFAULT_BRAND_COLOR
      setSaved(norm)
      setDraft(norm)
      setHexInput(norm)
      previewing.current = false // the value is now the real, persisted brand
      refreshFavicon()
      toast.success("Main color updated", { description: "The whole site and favicon now use this color." })
    } catch (err) {
      toast.error("Could not update the color", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className={!isDefault ? "border-primary/50" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot state="ok" />
          <Palette className="size-4 text-primary" aria-hidden />
          Site main color
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Sets the app&apos;s primary color everywhere — buttons, links, highlights, glows, the cookie logo tile and the
          browser favicon. Changes apply site-wide immediately.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading current color…
          </div>
        ) : (
          <>
            {/* Preview + presets */}
            <div className="flex items-center gap-3 rounded-md glass p-4">
              <span
                className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border"
                style={{ backgroundColor: draft }}
                aria-hidden
              >
                <Check className="size-5" style={{ color: brandCssVars(draft)["--primary-foreground"] }} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Live preview</p>
                <p className="mt-0.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">{draft}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {BRAND_PRESETS.map((p) => {
                const active = draft.toLowerCase() === p.hex.toLowerCase()
                return (
                  <button
                    key={p.hex}
                    type="button"
                    onClick={() => pick(p.hex)}
                    title={p.name}
                    aria-label={p.name}
                    aria-pressed={active}
                    className={`size-8 rounded-md border transition-all ${
                      active ? "border-foreground ring-2 ring-ring ring-offset-2 ring-offset-background" : "border-border"
                    }`}
                    style={{ backgroundColor: p.hex }}
                  />
                )
              })}
            </div>

            {/* Custom hex + native picker */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label htmlFor="brand-hex" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                  Custom hex
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="brand-picker"
                    type="color"
                    value={draft}
                    onChange={(e) => pick(e.target.value)}
                    className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                    aria-label="Pick a custom color"
                  />
                  <input
                    id="brand-hex"
                    value={hexInput}
                    onChange={(e) => setHexInput(e.target.value)}
                    onBlur={() => pick(hexInput)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) pick(hexInput)
                    }}
                    placeholder="#14b8a6"
                    spellCheck={false}
                    className="w-32 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => persist(null)}
                disabled={saving || (isDefault && draft === saved)}
              >
                <RotateCcw className="size-4" aria-hidden />
                Reset to default
              </Button>
              <Button type="button" size="sm" onClick={() => persist(draft)} disabled={saving || !dirty}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
                {saving ? "Saving…" : dirty ? "Save color" : "Saved"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
