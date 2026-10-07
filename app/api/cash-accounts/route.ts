import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listForCompany } from '@/lib/cash-accounts/service'

/**
 * GET /api/cash-accounts
 *
 * Returns the active company's cash accounts (cash_accounts table).
 *
 * Query params:
 *   - enabled_only=true → only accounts with enabled=true (default returns all)
 */
export const GET = withRouteContext('cash_accounts.list', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const url = new URL(request.url)
  const enabledOnly = url.searchParams.get('enabled_only') === 'true'

  const accounts = await listForCompany(supabase, companyId, { enabledOnly })
  return NextResponse.json({ data: accounts })
})
