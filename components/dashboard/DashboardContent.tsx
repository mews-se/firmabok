'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import ResumePane from '@/components/dashboard/ResumePane'
import type { WorklistCounts } from '@/lib/worklist/types'
import type { ResumeItem } from '@/lib/worklist/resume'

interface DashboardContentProps {
  /** Signed-in user's first name for the greeting; null falls back to a
   *  nameless greeting. */
  userFirstName?: string | null
  /** Unified pending-work counts from lib/worklist: same source as the sidebar badges. */
  worklist: WorklistCounts
  /** In-progress work for the Fortsätt pane (lib/worklist/resume). */
  resumeItems: ResumeItem[]
  /**
   * True when the company has zero posted journal entries: Att göra's
   * all-clear then reads as "empty, get started" instead of a false
   * "all caught up".
   */
  emptyLedger?: boolean
}

/**
 * Hem (concept scene 14): greeting, then the two panes side by side:
 * Att göra (obligations, lib/worklist) and Fortsätt (in-progress work,
 * lib/worklist/resume). KPI tiles, revenue/expense cards and the deadline/tax
 * widgets left the page (founder direction, dev_docs/last_session_resume.md
 * §8): the numbers live at /reports, deadlines render as Bevaka rows.
 */
export default function DashboardContent({
  userFirstName,
  worklist,
  resumeItems,
  emptyLedger = false,
}: DashboardContentProps) {
  const t = useTranslations('dashboard')
  const { company } = useCompany()

  // Time-of-day greeting (concept: "God morgon, Jakob."). Client-side clock
  // on purpose (the user's local morning, not the server's), captured once
  // so render stays pure.
  const [greetingNow] = useState(() => new Date())
  const hour = greetingNow.getHours()
  const greeting =
    hour < 10 ? t('greeting_morning') : hour < 17 ? t('greeting_day') : t('greeting_evening')
  const dateLine = new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(greetingNow)

  return (
    <div className="stagger-enter space-y-8">
      {/* Greeting hero (concept scene 14) */}
      <section>
        <h1 className="font-display text-2xl leading-8 tracking-tight">
          {userFirstName ? `${greeting}, ${userFirstName}.` : `${greeting}.`}
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {dateLine}
          {company?.name ? ` · ${company.name}` : ''}
        </p>
      </section>

      {/* The two panes (concept hem-grid). When nothing is in progress the
          right pane renders null and Att göra takes the full width. */}
      <div
        className={
          resumeItems.length > 0 ? 'grid items-start gap-x-6 gap-y-8 md:grid-cols-2' : undefined
        }
      >
        <AttGoraSection
          worklist={worklist}
          emptyLedger={emptyLedger}
        />
        <ResumePane items={resumeItems} />
      </div>
    </div>
  )
}
