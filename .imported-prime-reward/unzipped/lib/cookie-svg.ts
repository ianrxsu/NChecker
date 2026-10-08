// Single source of truth for the Cookies Mo brand mark. The cookie art is fixed;
// only the TILE (background) color changes so it can follow the site's dynamic
// main color. Consumed by:
//   - the dynamic favicon route (/api/icon) — inlines a concrete color server-side
//   - the inline <CookieMark> component — passes "currentColor" so CSS drives it
export function cookieSvg(tile: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Cookies Mo">
  <rect width="64" height="64" rx="10" fill="${tile}"/>
  <defs>
    <clipPath id="bite">
      <path d="M32 8a24 24 0 1 0 0 48 24 24 0 0 0 0-48Z M52 14a6 6 0 1 1-0.1 0Z M49 26a4.5 4.5 0 1 1-0.1 0Z" clip-rule="evenodd"/>
    </clipPath>
  </defs>
  <g clip-path="url(#bite)">
    <circle cx="32" cy="32" r="22" fill="#D9A86C" stroke="#111111" stroke-width="4"/>
  </g>
  <circle cx="32" cy="32" r="22" fill="none" stroke="#111111" stroke-width="4" stroke-dasharray="92 140" stroke-dashoffset="-18"/>
  <circle cx="22" cy="24" r="3.4" fill="#5A3217" stroke="#111111" stroke-width="2"/>
  <circle cx="24" cy="42" r="3" fill="#5A3217" stroke="#111111" stroke-width="2"/>
  <circle cx="40" cy="44" r="3.2" fill="#5A3217" stroke="#111111" stroke-width="2"/>
  <path d="M28 29l4 3.5-4 3.5" fill="none" stroke="#111111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="35" y="31" width="5" height="5" fill="#111111"/>
</svg>`
}
