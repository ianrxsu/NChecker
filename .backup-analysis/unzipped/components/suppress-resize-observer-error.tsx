"use client"

import { useEffect } from "react"

/**
 * Silences the benign "ResizeObserver loop completed with undelivered
 * notifications" (and the older "...loop limit exceeded") browser warning.
 *
 * This is NOT a real error: the browser emits it when a ResizeObserver callback
 * triggers another layout change that can't be delivered in the same frame. Our
 * virtualized results list (@tanstack/react-virtual + measureElement) legitimately
 * re-measures rows as they expand/collapse, which trips this warning. It has no
 * functional impact, but it bubbles up to the global error handler and shows in
 * the dev error overlay. We suppress ONLY this exact message and let every other
 * error through untouched.
 */
const RESIZE_OBSERVER_MESSAGES = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]

function isResizeObserverNoise(message: unknown): boolean {
  return typeof message === "string" && RESIZE_OBSERVER_MESSAGES.some((m) => message.includes(m))
}

export function SuppressResizeObserverError() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (isResizeObserverNoise(event.message)) {
        event.stopImmediatePropagation()
        event.preventDefault()
      }
    }
    // Capture phase so we intercept before framework/dev-overlay listeners.
    window.addEventListener("error", onError, true)
    return () => window.removeEventListener("error", onError, true)
  }, [])

  return null
}
