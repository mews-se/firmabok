import { NextResponse } from 'next/server'
import {
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/** GET: preview currency revaluation for a fiscal period. */
export const GET = withRouteContext(
  'period.fx_revaluation_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return errorResponseFromCode('FX_PERIOD_NOT_FOUND', opLog, { requestId })
    }

    try {
      const preview = await previewCurrencyRevaluation(supabase, companyId!, period.period_end)
      return NextResponse.json({ data: preview })
    } catch (err) {
      opLog.error('fx revaluation preview failed', err as Error)
      // Bookkeeping errors flow through errorResponse with their typed codes.
      return errorResponse(err, opLog, { requestId })
    }
  },
)

/** POST: execute currency revaluation, creating the period-end FX entry. */
export const POST = withRouteContext(
  'period.fx_revaluation',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return errorResponseFromCode('FX_PERIOD_NOT_FOUND', opLog, { requestId })
    }

    if (period.is_closed) {
      return errorResponseFromCode('FX_PERIOD_CLOSED', opLog, { requestId })
    }

    try {
      const result = await executeCurrencyRevaluation(
        supabase, companyId!, period.period_end, id, user.id,
      )

      if (!result) {
        return NextResponse.json({ data: null, message: 'No foreign currency items to revalue' })
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('fx revaluation execution failed', err as Error)
      // CurrencyRevaluationAlreadyExistsError + other typed errors flow through.
      const fallback = errorResponse(err, opLog, { requestId })
      if (fallback.status === 500) {
        return errorResponseFromCode('FX_FAILED', opLog, {
          requestId,
          details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
        })
      }
      return fallback
    }
  },
  { requireWrite: true },
)
