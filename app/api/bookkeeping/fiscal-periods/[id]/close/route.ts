import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { closePeriod } from '@/lib/core/bookkeeping/period-service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// Response shapes are legacy `{ error: string }` — kept for the year-end UI.
// closePeriod throws plain Errors for every refusal (period not found, drafts
// remaining, already closed); they all map to 400 as before.
export const POST = withRouteContext(
  'period.close',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId } = ctx

    try {
      const period = await closePeriod(supabase, companyId, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to close period' },
        { status: 400 }
      )
    }
  },
  { requireWrite: true },
)
