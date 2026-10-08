import { type NextRequest, NextResponse } from "next/server"

// The public app intentionally exposes only the Netflix checker. Admin and API
// routes remain available so the checker can keep its existing server functions.
function isInternal(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/")
}

function isNetflix(pathname: string): boolean {
  return pathname === "/netflix" || pathname.startsWith("/netflix/")
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (isInternal(pathname) || isNetflix(pathname)) {
    return NextResponse.next()
  }

  const url = req.nextUrl.clone()
  url.pathname = "/netflix"
  url.search = ""
  return NextResponse.redirect(url)
}

export const config = {
  // Exclude routes already exempt in isOpen before invoking middleware at all.
  // Public page and RSC requests still run both existing access gates.
  matcher: ["/((?!admin(?:/|$)|api(?:/|$)|public-access(?:/|$)|maintenance(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|json|mp3|woff2?)).*)"],
}
