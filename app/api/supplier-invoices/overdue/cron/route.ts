import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/supplier-invoices/overdue/cron, daily 06:00 UTC.
 *
 * Flips supplier invoices past their due date to 'overdue'. This ran as a
 * pg_cron job originally; scheduling moved here so the database needs no
 * cron extension and the run shows up in the same logs as every other job.
 * The function itself stays in the database: it is a single set-based
 * UPDATE, and service_role is the only role allowed to execute it.
 */
export const GET = withCronContext('cron.supplier_invoices_overdue', async (_request, ctx) => {
  const supabase = createServiceClient()

  const { error } = await supabase.rpc('update_overdue_supplier_invoices')
  if (error) {
    ctx.log.error('overdue supplier invoice sweep failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  ctx.log.info('overdue supplier invoice sweep completed')
  return NextResponse.json({ success: true })
})
