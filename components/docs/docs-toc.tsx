"use client"

import { useEffect, useState } from "react"

export type DocSection = { id: string; title: string }

// Sticky sidebar table of contents with scroll-spy. Highlights the section
// currently in view and smooth-scrolls on click. Purely a navigation aid — the
// content renders fine without it (progressive enhancement).
export function DocsToc({ sections }: { sections: DocSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "")

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null)
    if (els.length === 0) return

    // Mark the topmost section whose heading is within the top third of the
    // viewport as active. rootMargin biases toward the section you're reading.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "0px 0px -66% 0px", threshold: 0 },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [sections])

  return (
    <aside className="hidden lg:block">
      <nav aria-label="On this page" className="sticky top-6 flex flex-col gap-1">
        <span className="mb-2 text-xs font-semibold uppercase tracking-widest text-foreground">On this page</span>
        {sections.map((s) => {
          const isActive = active === s.id
          return (
            <a
              key={s.id}
              href={`#${s.id}`}
              aria-current={isActive ? "location" : undefined}
              className={`border-l py-1 pl-3 text-[13px] font-bold leading-snug transition-colors ${
                isActive
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.title}
            </a>
          )
        })}
      </nav>
    </aside>
  )
}
