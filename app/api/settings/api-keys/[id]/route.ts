import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * DELETE /api/settings/api-keys/[id]: Revoke an API key (soft delete)
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'api_key.revoke',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('revoked_at', null)

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
