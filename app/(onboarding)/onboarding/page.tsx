import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'

export const dynamic = 'force-dynamic'

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ org_number?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Invite recovery: an invitee normally never reaches this page (the client
  // flows or the auth callback attach them to the company first), so landing
  // here with a live invite cookie means acceptance was missed. Retry it and
  // skip onboarding entirely on success; if only a pending invitation exists
  // (cookie lost, e.g. confirmation opened on another device), surface a hint
  // instead of silently asking the invitee to create a company.
  const inviteToken = (await cookies()).get('gnubok-invite-token')?.value
  if (inviteToken && (await acceptPendingInviteByToken(user, inviteToken))) {
    redirect('/')
  }
  const hasPendingInvite = user.email
    ? await hasPendingInviteForEmail(user.email)
    : false

  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  let teamId = teamMembership?.team_id

  // Ensure user has a team (fallback for edge cases)
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }

  if (!teamId) {
    redirect('/login')
  }

  // A ?org_number=… deep link pre-fills the first question. Strip formatting
  // so what the journey displays matches what the flow will store.
  const { org_number: rawOrgNumber } = await searchParams
  const initialOrgNumber = rawOrgNumber ? rawOrgNumber.replace(/[\s-]/g, '') : undefined

  return (
    <OnboardingJourney
      teamId={teamId}
      mode="first"
      initialOrgNumber={initialOrgNumber}
      // A deep-linked orgnr is a deliberate create-this-company pick from the
      // BankID list: don't distract that flow with the invite hint.
      hasPendingInvite={hasPendingInvite && !initialOrgNumber}
    />
  )
}
