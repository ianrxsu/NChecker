// Lightweight UI sound engine built on the Web Audio API — no audio files needed.
// Clicks are synthesized on the fly, so there are no network requests or assets.
// State (on/off) is persisted to localStorage and broadcast to subscribers so the
// toggle button and the global click listener stay in sync.

const STORAGE_KEY = "cm-sound-enabled"

let enabled = true
let loaded = false
let ctx: AudioContext | null = null
const listeners = new Set<() => void>()

// Read the saved preference once (defaults to on). Safe to call repeatedly.
export function loadSoundPref(): void {
  if (loaded || typeof window === "undefined") return
  loaded = true
  const v = window.localStorage.getItem(STORAGE_KEY)
  if (v !== null) enabled = v === "1"
}

export function isSoundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(value: boolean): void {
  enabled = value
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0")
  }
  if (value) void getCtx()?.resume()
  listeners.forEach((fn) => fn())
}

// Subscribe to on/off changes; returns an unsubscribe function.
export function subscribeSound(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// AudioContext is created lazily inside a user gesture so browsers allow audio.
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

type Tone = {
  freq: number
  type: OscillatorType
  duration: number
  gain: number
  sweepTo?: number
  // Seconds to wait before this tone starts, relative to when play() was called.
  // Lets a single call schedule a little melody (used by the outcome chimes).
  delay?: number
}

// Render a single short enveloped tone. Bypassed entirely when muted.
function play(tone: Tone, force = false): void {
  if (!enabled && !force) return
  const ac = getCtx()
  if (!ac) return
  if (ac.state === "suspended") void ac.resume()

  const start = ac.currentTime + (tone.delay ?? 0)
  const osc = ac.createOscillator()
  const gain = ac.createGain()

  osc.type = tone.type
  osc.frequency.setValueAtTime(tone.freq, start)
  if (tone.sweepTo) {
    osc.frequency.exponentialRampToValueAtTime(tone.sweepTo, start + tone.duration)
  }

  // Fast attack, exponential decay — a crisp, non-fatiguing UI tick.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration)

  osc.connect(gain).connect(ac.destination)
  osc.start(start)
  osc.stop(start + tone.duration + 0.02)
}

// Play a short sequence of tones as one logical sound (a chime/arpeggio).
function playSequence(tones: Tone[], force = false): void {
  // Cheap early-out so a muted app schedules nothing at all.
  if (!enabled && !force) return
  for (const tone of tones) play(tone, force)
}

// A subtle click for general button/link presses.
export function playClick(): void {
  play({ freq: 420, type: "triangle", duration: 0.055, gain: 0.045 })
}

// Rising confirmation when enabling sound (forced so it always plays).
export function playToggleOn(): void {
  play({ freq: 360, sweepTo: 720, type: "sine", duration: 0.13, gain: 0.06 }, true)
}

// Falling confirmation when disabling sound (forced so it plays once on the way out).
export function playToggleOff(): void {
  play({ freq: 520, sweepTo: 220, type: "sine", duration: 0.13, gain: 0.05 }, true)
}

// ─── Outcome sounds ──────────────────────────────────────────────────────────
// These fire when a cookie check resolves, so a user gets satisfying audible
// feedback without watching the screen. All honor the global mute preference.

// Valid / alive cookie — a bright ascending major arpeggio (C6-E6-G6) that
// resolves upward. Reads as a rewarding "success!" ding.
export function playSuccess(): void {
  playSequence([
    { freq: 1046.5, type: "triangle", duration: 0.11, gain: 0.06, delay: 0 },
    { freq: 1318.5, type: "triangle", duration: 0.11, gain: 0.06, delay: 0.09 },
    { freq: 1568.0, type: "triangle", duration: 0.2, gain: 0.07, delay: 0.18 },
  ])
}

// Dead / invalid cookie — a soft, low descending two-note "nope". Gentle
// (sine, low gain) so a long list of dead results never gets grating.
export function playDead(): void {
  playSequence([
    { freq: 349.2, type: "sine", duration: 0.12, gain: 0.05, delay: 0 },
    { freq: 261.6, type: "sine", duration: 0.18, gain: 0.05, delay: 0.1 },
  ])
}

// Service error (could NOT verify — timeout, rate limit, upstream down). A
// distinct buzzy low double-beep so it's clearly different from a dead cookie.
export function playError(): void {
  playSequence([
    { freq: 196.0, type: "sawtooth", duration: 0.13, gain: 0.045, delay: 0 },
    { freq: 196.0, type: "sawtooth", duration: 0.13, gain: 0.045, delay: 0.17 },
  ])
}

// Bulk run finished — a fuller four-note rising fanfare to mark completion of a
// whole batch (distinct from the single-cookie success ding).
export function playComplete(): void {
  playSequence([
    { freq: 523.3, type: "triangle", duration: 0.1, gain: 0.055, delay: 0 },
    { freq: 659.3, type: "triangle", duration: 0.1, gain: 0.055, delay: 0.08 },
    { freq: 784.0, type: "triangle", duration: 0.1, gain: 0.06, delay: 0.16 },
    { freq: 1046.5, type: "triangle", duration: 0.24, gain: 0.07, delay: 0.24 },
  ])
}
