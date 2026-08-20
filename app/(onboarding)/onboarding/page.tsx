import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'

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

  // A ?org_number=… deep link pre-fills the first question. Strip formatting
  // so what the journey displays matches what the flow will store.
  const { org_number: rawOrgNumber } = await searchParams
  const initialOrgNumber = rawOrgNumber ? rawOrgNumber.replace(/[\s-]/g, '') : undefined

  return <OnboardingJourney initialOrgNumber={initialOrgNumber} />
}
