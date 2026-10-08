import { type NextRequest, NextResponse } from "next/server"
import { isMaintenanceEnabled } from "@/lib/maintenance-mode"
import { PUBLIC_ACCESS_COOKIE, isPublicAccessEnabled, validPublicAccessCookie } from "@/lib/public-access"

// Global kill switch. When an admin enables maintenance mode, this rewrites every
// PUBLIC page to /maintenance. We deliberately let a few paths through:
//   • /admin*        — so the admin can still log in and flip the switch back off
//   • /api/*         — keeps the kill-switch toggle, admin auth, AND the LootLabs
//                      server-to-server postback working (payouts must not break)
//   • /maintenance   — the screen we rewrite to (avoid a redirect loop)
//   • static assets  — handled by the matcher below
function isOpen(pathname: string): boolean {
  return pathname === "/public-access" || pathname.startsWith("/admin") || pathname.startsWith("/api/") || pathname === "/maintenance"
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (isOpen(pathname)) {
    return NextResponse.next()
  }

  // Keep the global middleware fail-open if the optional Redis gate is unavailable.
  try {
    if (!(await isPublicAccessEnabled())) return NextResponse.next()
  } catch {
    return NextResponse.next()
  }

  if (!(await validPublicAccessCookie(req.cookies.get(PUBLIC_ACCESS_COOKIE)?.value))) {
    const url = req.nextUrl.clone()
    url.pathname = "/public-access"
    url.search = `?next=${encodeURIComponent(pathname)}`
    return NextResponse.redirect(url)
  }

  // Only touch Redis for pages we might actually gate. Fails open inside the lib.
  try {
    if (!(await isMaintenanceEnabled())) return NextResponse.next()
  } catch {
    return NextResponse.next()
  }

  {
    const url = req.nextUrl.clone()
    url.pathname = "/maintenance"
    // Rewrite (not redirect) so the URL the visitor typed is preserved, and serve
    // a 503 so crawlers treat it as a temporary outage rather than real content.
    return NextResponse.rewrite(url, { status: 503 })
  }

  return NextResponse.next()
}

export const config = {
  // Run on everything except Next internals and static asset files. The function
  // body further narrows which paths are gated.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|json|mp3|woff2?)).*)"],
}
