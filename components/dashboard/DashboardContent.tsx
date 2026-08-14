'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { AttnLine } from '@/components/ui/attn-line'
import { useCompany } from '@/contexts/CompanyContext'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import ResumePane from '@/components/dashboard/ResumePane'
import type { InitialSetupState, OnboardingProgress } from '@/types'
import type { SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'
import type { ResumeItem } from '@/lib/worklist/resume'
import type { VatDeadlineLine } from '@/lib/onboarding/checklist'

interface DashboardContentProps {
  /** Signed-in user's first name for the greeting; null falls back to a
   *  nameless greeting. */
  userFirstName?: string | null
  /** Expiring PSD2 consents (dashboard-only worklist extra). */
  expiringBankConnections?: { id: string; bank_name: string; days_left: number }[]
  /** Unified pending-work counts from lib/worklist: same source as the sidebar badges. */
  worklist: WorklistCounts
  /** High-confidence transaction↔invoice matches for inline one-click confirm. */
  suggestedMatches: SuggestedMatch[]
  /** In-progress work for the Fortsätt pane (lib/worklist/resume). */
  resumeItems: ResumeItem[]
  /**
   * True when this account looks bookkeeping-empty while a same-orgnr
   * company with real bookkeeping exists in another account (#1231): the
   * user probably signed in with the wrong login (stale BankID account).
   */
  otherAccountHint?: boolean
  onboardingProgress?: OnboardingProgress
  initialSetup: InitialSetupState
  /** Personalized VAT-deadline line for the checklist's Skatteverket step. */
  vatLine?: VatDeadlineLine
  /**
   * True while the setup checklist is still open and the company has zero
   * posted journal entries: Att göra's all-clear then reads as "empty, get
   * started" instead of a false "all caught up".
   */
  emptyLedger?: boolean
}

/**
 * Hem (concept scene 14): greeting, then the two panes side by side:
 * Att göra (obligations, lib/worklist) and Fortsätt (in-progress work,
 * lib/worklist/resume). KPI tiles, revenue/expense cards and the deadline/tax
 * widgets left the page (founder direction, dev_docs/last_session_resume.md
 * §8): the numbers live at /kpi and /reports, deadlines render as Bevaka rows.
 */
export default function DashboardContent({
  userFirstName,
  expiringBankConnections,
  worklist,
  suggestedMatches,
  resumeItems,
  otherAccountHint = false,
  onboardingProgress,
  initialSetup,
  vatLine = null,
  emptyLedger = false,
}: DashboardContentProps) {
  const t = useTranslations('dashboard')
  const { company } = useCompany()
  const router = useRouter()

  // Wrong-account hint action: sign out so the user can come back in with
  // their other login (email+password). Same flow as SandboxBanner.
  async function handleSwitchAccount() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

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
        {otherAccountHint && (
          <AttnLine
            className="mt-3"
            action={{ label: t('other_account_hint_action'), onClick: handleSwitchAccount }}
          >
            {t('other_account_hint')}
          </AttnLine>
        )}
      </section>

      <NewUserChecklist
        initialState={initialSetup}
        hasBookkeepingImported={!!onboardingProgress?.hasSIEImport}
        hasBankConnected={!!onboardingProgress?.hasBankConnected}
        hasSkatteverketConnected={!!onboardingProgress?.hasSkatteverketConnected}
        hasInboxItems={!!onboardingProgress?.hasInboxItems}
        vatLine={vatLine}
      />

      {/* The two panes (concept hem-grid). When nothing is in progress the
          right pane renders null and Att göra takes the full width. */}
      <div
        className={
          resumeItems.length > 0 ? 'grid items-start gap-x-6 gap-y-8 md:grid-cols-2' : undefined
        }
      >
        <AttGoraSection
          worklist={worklist}
          suggestedMatches={suggestedMatches}
          expiringBankConnections={expiringBankConnections}
          emptyLedger={emptyLedger}
        />
        <ResumePane items={resumeItems} />
      </div>
    </div>
  )
}
