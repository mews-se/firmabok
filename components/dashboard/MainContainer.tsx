'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

/**
 * Centered max-w-5xl container for the dashboard pages. Lives in a client
 * component because the parent (dashboard) layout is shared across all
 * dashboard routes and the panel scroll has to reset on every route change.
 */
export function MainContainer({
  companyId,
  children,
}: {
  companyId: string | null
  children: ReactNode
}) {
  const pathname = usePathname()

  // The panel (<main>) is its own scroll container on desktop, so Next's
  // built-in scroll-to-top on navigation (which targets the window) never
  // fires for it. Reset the panel scroll on every route change; hash-anchor
  // scrolling still works because pages call scrollIntoView themselves.
  useEffect(() => {
    document.getElementById('main-content')?.scrollTo(0, 0)
  }, [pathname])

  return (
    <div key={companyId ?? ''} className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10">
      {children}
    </div>
  )
}
