"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { SplashScreen } from "@/components/splash-screen"

export function PublicSite({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const privateWorkspace = /^\/(admin|mod)(\/|$)/.test(pathname)

  if (privateWorkspace) return <><div className="tc-ambient" aria-hidden /><SplashScreen />{children}</>
  return <div className="public-site min-h-svh bg-background font-sans text-foreground">{children}</div>
}
