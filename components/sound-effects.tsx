"use client"

import { useEffect } from "react"
import { loadSoundPref, playClick } from "@/lib/sound"

// Interactive elements that should emit a click sound when pressed.
const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], summary, [data-sound="click"]'

// Mounted once in the root layout. Uses a single delegated, capture-phase
// pointerdown listener so every button/link in the app gets a click sound for
// free — no need to wire each component individually. Honors the global mute
// preference and skips disabled elements or anything marked data-no-sound
// (e.g. the sound toggle itself, which plays its own confirmation tone).
export function SoundEffects() {
  useEffect(() => {
    loadSoundPref()

    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null
      const el = target?.closest(INTERACTIVE)
      if (!el) return
      if (el.hasAttribute("data-no-sound")) return
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return
      playClick()
    }

    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [])

  return null
}
