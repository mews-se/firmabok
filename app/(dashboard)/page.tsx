import { redirect } from 'next/navigation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getWorklistCounts } from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
} from './request-context'

export const dynamic = 'force-dynamic'

// Home route = Hem (concept scene 14): greeting + Att göra + Fortsätt.
// The KPI/revenue/deadline widgets left the page (founder direction,
// dev_docs/last_session_resume.md §8), which also pruned their fetches:
// the journal-line YTD aggregation, unpaid-invoice totals and deadline
// queries are gone and the page got faster.

export default async function DashboardPage() {
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])

  if (!user) {
    redirect('/login')
  }

  if (!companyId) {
    redirect('/onboarding')
  }

  // Fetch all data in parallel
  const [
    settingsRes,
    { count: postedEntryCount, error: postedEntryError },
    { data: profile },
    worklist,
    resumeItems,
  ] = await Promise.all([
    getDashboardSettings(),
    // Posted entries distinguish "brand-new empty ledger" from "all caught
    // up" in the Att göra empty state (hits the partial posted/reversed index).
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['posted', 'reversed']),
    // First name for the greeting.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    // Pending-work counts come from lib/worklist: the same source as the
    // sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    // In-progress work for the Fortsätt pane: pure draft-state derivation.
    listResumeItems(supabase, companyId),
  ])

  // A FAILED settings read must not masquerade as "onboarding not done":
  // that sent fully onboarded users back to the wizard on a transient query
  // failure (issue #1053). Throw to the error boundary (retryable) and only
  // redirect on a genuinely incomplete or missing settings row.
  const { data: settings, error: settingsError } = settingsRes
  if (settingsError) {
    throw new Error(`company_settings fetch failed: ${settingsError.message}`)
  }

  // If onboarding is not complete, redirect to onboarding
  if (!settings?.onboarding_complete) {
    redirect('/onboarding')
  }

  // A failed count must NOT read as empty: that would tell a company with
  // real bookkeeping that its ledger is blank, so errors degrade to the
  // normal all-clear copy.
  const emptyLedger = !postedEntryError && (postedEntryCount || 0) === 0

  const userFirstName = profile?.full_name?.trim().split(/\s+/)[0] ?? null

  return (
    <DashboardContent
      userFirstName={userFirstName}
      worklist={worklist}
      resumeItems={resumeItems}
      emptyLedger={emptyLedger}
    />
  )
}
