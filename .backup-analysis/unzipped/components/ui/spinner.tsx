import { cn } from "@/lib/utils"

/**
 * Custom loading spinner — a conic-gradient ring driven purely by a CSS rotate
 * animation (see `.cn-spinner` in globals.css). Unlike a lucide `Loader2` with
 * `animate-spin`, this is a compositor-friendly transform so it keeps spinning
 * smoothly and never appears to "freeze" while the app is busy.
 *
 * Size is controlled with width/height utility classes (defaults to size-4).
 * Thickness can be tuned via the `--cn-spinner-thickness` CSS variable.
 */
export function Spinner({
  className,
  thickness,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { thickness?: number }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("cn-spinner size-4", className)}
      style={thickness ? ({ "--cn-spinner-thickness": `${thickness}px` } as React.CSSProperties) : undefined}
      {...props}
    />
  )
}
