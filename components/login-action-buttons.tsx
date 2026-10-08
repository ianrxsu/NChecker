"use client"

import type { ReactNode } from "react"
import { useState } from "react"

export function TelegramLoginButton() {
  const [loading, setLoading] = useState(false)

  return (
    <a
      href="https://t.me/cookiesmo_bot?start=website_login"
      onClick={() => setLoading(true)}
      aria-busy={loading}
      className="mt-6 flex min-h-11 items-center justify-center bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
    >
      {loading ? "Opening Telegram..." : "Quick login with Telegram"}
    </a>
  )
}

export function LoadingLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const [loading, setLoading] = useState(false)

  return (
    <a
      href={href}
      onClick={() => setLoading(true)}
      aria-busy={loading}
      className={className}
    >
      {loading ? "Loading..." : children}
    </a>
  )
}
