'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

/**
 * Picks the dashboard chrome container based on route. Extension workspaces
 * (/e/*) and the /chat app shell want the full viewport for their own
 * multi-pane layouts; everything else gets the centered max-w-5xl card.
 *
 * Lives in a client component because the parent (dashboard) layout is
 * shared across all dashboard routes. Server-side pathname checks done in
 * the layout don't re-evaluate reliably on soft navigation between sibling
 * routes, so the wrapper class would otherwise stick on whichever branch
 * the first render picked.
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

  // The salary run detail page drives a wide, horizontal-flow layout (progress
  // band + 5-up KPIs + full-width employee ledger) that the standard max-w-5xl
  // column squeezes. It opts into a wider canvas — a deliberate, scoped
  // exception to the locked container token. Match only /salary/runs/{id}, not
  // its nested employee sub-pages.
  const isWide = /^\/salary\/runs\/[^/]+$/.test(pathname)

  return (
    <div
      key={companyId ?? ''}
      className={
        isWide
          ? 'max-w-7xl mx-auto px-5 py-8 md:px-8 md:py-10'
          : 'max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10'
      }
    >
      {children}
    </div>
  )
}
