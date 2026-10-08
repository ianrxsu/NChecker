"use client"

import { useEffect, useState } from "react"
import { Volume2, VolumeX } from "lucide-react"
import {
  isSoundEnabled,
  setSoundEnabled,
  subscribeSound,
  loadSoundPref,
  playToggleOn,
  playToggleOff,
} from "@/lib/sound"

// Footer control to mute/unmute UI sounds. Marked data-no-sound so the global
// click listener doesn't double up — it plays its own rising/falling tone.
export function SoundToggle() {
  const [on, setOn] = useState(true)

  useEffect(() => {
    loadSoundPref()
    setOn(isSoundEnabled())
    return subscribeSound(() => setOn(isSoundEnabled()))
  }, [])

  const handleClick = () => {
    const next = !isSoundEnabled()
    if (next) {
      setSoundEnabled(true)
      playToggleOn()
    } else {
      // Play the confirmation BEFORE muting so it's audible on the way out.
      playToggleOff()
      setSoundEnabled(false)
    }
  }

  return (
    <button
      type="button"
      data-no-sound
      onClick={handleClick}
      aria-pressed={on}
      className="press inline-flex w-fit items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-[11px] tracking-widest text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      {on ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
      {on ? "Sound on" : "Sound off"}
    </button>
  )
}
