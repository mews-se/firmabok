import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/invoices/deliveries/redact/cron, daily 03:15 UTC.
 *
 * Removes recipient and message PII from invoice deliveries once their
 * statutory retention window (BFL 7 kap) has passed; the function and its
 * semantics live in the database (redact_expired_invoice_delivery_pii).
 * This ran as a pg_cron job originally; scheduling moved here so the
 * database needs no cron extension.
 */
export const GET = withCronContext('cron.invoice_deliveries_redact', async (_request, ctx) => {
  const supabase = createServiceClient()

  const { error } = await supabase.rpc('redact_expired_invoice_delivery_pii')
  if (error) {
    ctx.log.error('invoice delivery PII redaction failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  ctx.log.info('invoice delivery PII redaction completed')
  return NextResponse.json({ success: true })
})
