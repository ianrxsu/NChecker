import { cn } from "@/lib/utils"

// The Cookies Mo logo — the same cookie glyph as the favicon, drawn inline so its
// TILE (background) tracks the site's dynamic main color via `var(--primary)`.
// Purely visual; callers provide the adjacent text label, so it's aria-hidden.
export function CookieMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-full", className)}
      aria-hidden
      focusable="false"
    >
      {/* Tile = the dynamic brand color */}
      <rect width="64" height="64" rx="10" fill="var(--primary)" />
      <defs>
        <clipPath id="cookie-bite">
          <path
            d="M32 8a24 24 0 1 0 0 48 24 24 0 0 0 0-48Z M52 14a6 6 0 1 1-0.1 0Z M49 26a4.5 4.5 0 1 1-0.1 0Z"
            clipRule="evenodd"
          />
        </clipPath>
      </defs>
      <g clipPath="url(#cookie-bite)">
        <circle cx="32" cy="32" r="22" fill="#D9A86C" stroke="#111111" strokeWidth="4" />
      </g>
      <circle
        cx="32"
        cy="32"
        r="22"
        fill="none"
        stroke="#111111"
        strokeWidth="4"
        strokeDasharray="92 140"
        strokeDashoffset="-18"
      />
      <circle cx="22" cy="24" r="3.4" fill="#5A3217" stroke="#111111" strokeWidth="2" />
      <circle cx="24" cy="42" r="3" fill="#5A3217" stroke="#111111" strokeWidth="2" />
      <circle cx="40" cy="44" r="3.2" fill="#5A3217" stroke="#111111" strokeWidth="2" />
      <path
        d="M28 29l4 3.5-4 3.5"
        fill="none"
        stroke="#111111"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="35" y="31" width="5" height="5" fill="#111111" />
    </svg>
  )
}
