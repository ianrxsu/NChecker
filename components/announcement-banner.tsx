"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import type { Announcement } from "@/lib/announcement"

function renderMessage(message: string) {
  const parts = message.split(/(\(link=[^,]+,\s*text="[^"]*"\)|https?:\/\/[^\s]+)/g)

  return parts.map((part, index) => {
    const customLink = part.match(/^\(link=([^,]+),\s*text="([^"]*)"\)$/)
    const href = customLink?.[1].trim()
    const label = customLink?.[2]
    const isUrl = /^https?:\/\//.test(part)

    if (customLink || isUrl) {
      const target = href || part
      const safeHref = /^https?:\/\//.test(target) ? target : `https://${target}`
      return (
        <a key={index} href={safeHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">
          {label || part}
        </a>
      )
    }

    return <span key={index}>{part}</span>
  })
}

export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  const pathname = usePathname()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [isLong, setIsLong] = useState(false)
  const [duration, setDuration] = useState(30)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const updateOverflow = () => {
      const long = viewport.scrollWidth > viewport.clientWidth + 1
      setIsLong(long)
      if (long) setDuration(Math.max(24, viewport.scrollWidth / 55))
    }

    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [announcement?.message])

  const isPrivateWorkspace = pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/mod" || pathname.startsWith("/mod/")
  if (!announcement || isPrivateWorkspace) return null
  const content = renderMessage(announcement.message)

  return (
    <aside className="fixed inset-x-0 top-0 z-50 flex h-10 items-center overflow-hidden border-b border-primary/30 bg-primary px-4 text-primary-foreground" role="status">
      <div ref={viewportRef} className="mx-auto max-w-7xl overflow-hidden whitespace-nowrap text-center text-sm leading-relaxed">
        <div className={isLong ? "announcement-marquee inline-flex min-w-max items-center gap-16" : "inline-flex min-w-full justify-center"} style={isLong ? { animationDuration: `${duration}s` } : undefined}>
          <span>{content}</span>
          {isLong && <span aria-hidden="true">{content}</span>}
        </div>
      </div>
    </aside>
  )
}
