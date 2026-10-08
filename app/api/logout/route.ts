import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { redis, redisEnabled } from "@/lib/redis"

async function logoutResponse(request: Request) {
  const telegramSubject = (await cookies()).get("cm_telegram_subject")?.value
  if (redisEnabled && telegramSubject) {
    await redis.set(`logout:telegram:${telegramSubject}`, "1", { ex: 60 * 60 * 24 * 30 })
  }
  const response = NextResponse.redirect(new URL("/login?logged_out=1", request.url), 303)
  response.headers.set("Cache-Control", "no-store, max-age=0")
  const cookieOptions = {
    expires: new Date(0),
    maxAge: 0,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
  }
  const cookieNames = new Set([
    "cm_telegram_subject",
    "cm_lifetime_session",
    "reward_token",
    "received_accounts",
    "public_access",
    ...request.headers.get("cookie")?.split(";").map((cookie) => cookie.trim().split("=")[0]).filter((name) => Boolean(name) && name !== "cm_did") ?? [],
  ])
  // Delete host-only cookies first. This is the form used by the free Telegram
  // session and device cookies on cookiesmo.i4n.tech.
  for (const cookieName of cookieNames) {
    response.cookies.delete(cookieName)
  }
  for (const domain of ["i4n.tech", ".i4n.tech", "cookiesmo.i4n.tech", "cm.i4n.tech"]) {
    for (const cookieName of cookieNames) {
      response.cookies.set(cookieName, "", { ...cookieOptions, domain })
    }
  }
  return response
}

export async function GET(request: Request) {
  return logoutResponse(request)
}

export async function POST(request: Request) {
  return logoutResponse(request)
}
