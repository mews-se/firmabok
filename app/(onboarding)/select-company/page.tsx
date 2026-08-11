import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { setActiveCompany } from '@/lib/company/context'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'
import CompanyPicker, {
  type MemberCompany,
} from '@/components/onboarding/CompanyPicker'

export const dynamic = 'force-dynamic'

export default async function SelectCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ choose?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Invite recovery, same as /onboarding: a missed invite acceptance (e.g. a
  // register flow that dropped the cookie handling) gets retried before the
  // picker funnels the invitee into creating a company.
  const inviteToken = (await cookies()).get('gnubok-invite-token')?.value
  if (inviteToken && (await acceptPendingInviteByToken(user, inviteToken))) {
    redirect('/')
  }

  // All lookups key only on user.id/email, one parallel batch instead of
  // serial round-trips.
  const [
    // Existing memberships.
    { data: memberships },
    { data: teamMembership },
    // Greeting name.
    { data: profile },
    // Pending invitation for this email with no cookie to accept it from:
    // rendered as a "check your invite email" hint in the picker.
    hasPendingInvite,
  ] = await Promise.all([
    supabase
      .from('company_members')
      .select(`
        role,
        company:company_id (
          id,
          name,
          org_number,
          entity_type,
          archived_at
        )
      `)
      .eq('user_id', user.id)
      .order('joined_at', { ascending: true }),
    supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
    user.email ? hasPendingInviteForEmail(user.email) : Promise.resolve(false),
  ])

  type CompanyRow = {
    id: string
    name: string
    org_number: string | null
    entity_type: string | null
    archived_at: string | null
  }

  const memberCompanies: MemberCompany[] = ((memberships ?? []) as unknown as Array<{
    role: string
    // Supabase's generated types can express this as either a single object
    // or an array depending on the relationship graph; handle both shapes.
    company: CompanyRow | CompanyRow[] | null
  }>)
    .map((m) => ({
      role: m.role,
      company: Array.isArray(m.company) ? m.company[0] ?? null : m.company,
    }))
    .filter((m): m is { role: string; company: CompanyRow } => !!m.company && !m.company.archived_at)
    .map((m) => ({
      id: m.company.id,
      name: m.company.name,
      orgNumber: m.company.org_number,
      entityType: m.company.entity_type,
      role: m.role,
    }))

  // Ensure the user has a team (same pattern as /onboarding).
  let teamId = teamMembership?.team_id
  if (!teamId) {
    const { data: ensured } = await supabase.rpc('ensure_user_team')
    teamId = ensured ?? null
  }
  if (!teamId) {
    redirect('/login')
  }

  const firstName = profile?.full_name?.split(' ')[0] ?? null

  // A member of exactly one company with nothing else to decide gets sent
  // straight in instead of clicking the only row on every login. `?choose=1`
  // (the in-app switcher links) always renders the picker, and
  // multi-company/byra users are untouched.
  const { choose } = await searchParams
  if (!choose && memberCompanies.length === 1 && !hasPendingInvite) {
    // redirect() throws NEXT_REDIRECT, so it must stay outside the try.
    let switched = false
    try {
      await setActiveCompany(supabase, user.id, memberCompanies[0].id)
      switched = true
    } catch {
      // Fall through to the picker: rendering it is always safe.
    }
    if (switched) redirect('/')
  }

  return (
    <CompanyPicker
      firstName={firstName}
      teamId={teamId}
      memberCompanies={memberCompanies}
      hasPendingInvite={hasPendingInvite}
    />
  )
}
