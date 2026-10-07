import { redirect } from 'next/navigation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
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

  const now = new Date()

  // Fetch all data in parallel
  const [
    settingsRes,
    { data: bankConnections },
    { count: postedEntryCount, error: postedEntryError },
    { data: profile },
    worklist,
    suggestedMatches,
    resumeItems,
  ] = await Promise.all([
    getDashboardSettings(),
    supabase.from('bank_connections').select('id, status, consent_expires, bank_name').eq('company_id', companyId).eq('status', 'active'),
    // Posted entries distinguish "brand-new empty ledger" from "all caught
    // up" in the Att göra empty state (hits the partial posted/reversed index).
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['posted', 'reversed']),
    // First name for the greeting.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    // Pending-work counts + suggested matches come from lib/worklist: the
    // same source as the sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    listSuggestedMatches(supabase, companyId, 5),
    // In-progress work for the Fortsätt pane: pure draft-state derivation.
    listResumeItems(supabase, companyId, now),
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

  const nowMs = now.getTime()
  const expiringBankConnections = (bankConnections || [])
    .filter(conn => {
      if (!conn.consent_expires) return false
      const daysLeft = Math.ceil(
        (new Date(conn.consent_expires).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      )
      return daysLeft > 0 && daysLeft <= 14
    })
    .map(conn => ({
      id: conn.id as string,
      bank_name: conn.bank_name as string,
      days_left: Math.ceil(
        (new Date(conn.consent_expires!).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      ),
    }))

  const userFirstName = profile?.full_name?.trim().split(/\s+/)[0] ?? null

  return (
    <DashboardContent
      userFirstName={userFirstName}
      expiringBankConnections={expiringBankConnections}
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      resumeItems={resumeItems}
      emptyLedger={emptyLedger}
    />
  )
}
