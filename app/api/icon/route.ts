import { NextResponse } from "next/server"
import { getBrandColor } from "@/lib/brand-color"
import { cookieSvg } from "@/lib/cookie-svg"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Dynamic, brand-colored favicon. Returns the cookie mark as an SVG with its tile
// painted in the site's current main color, so the favicon tracks whatever an
// admin sets. SVG favicons are honored by all modern browsers; a short CDN cache
// keeps this cheap while still propagating a color change within the minute.
export async function GET() {
  const { color } = await getBrandColor()
  return new NextResponse(cookieSvg(color), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  })
}
