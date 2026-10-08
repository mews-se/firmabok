import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'

const log = createLogger('invoice-payment-row')

export interface RecordInvoicePaymentRowParams {
  userId: string
  companyId: string
  invoice: {
    id: string
    currency?: string | null
    exchange_rate?: number | null
    paid_amount?: number | null
  }
  /** Booking date (YYYY-MM-DD), the same as the payment voucher's. */
  paymentDate: string
  /** paid_amount after this payment, in invoice currency. */
  newPaidAmount: number
  journalEntryId: string
}

export type RecordInvoicePaymentRowResult =
  | { ok: true; id: string }
  /** `code` is the Postgres SQLSTATE when the driver reported one. */
  | { ok: false; error: string; code?: string }

/**
 * Write the invoice_payments row (kundreskontra) for a payment the app books
 * itself. The row carries the payment's date and amount: the kontantmetod
 * cut-off, the as-of reskontra and the payment reversal read it.
 *
 * `amount` is the amount applied to the invoice (new paid_amount minus the
 * prior one) in invoice currency, never the cash received: an öresavrundning
 * residual on 3740 belongs to the voucher, not to the receivable.
 */
export async function recordInvoicePaymentRow(
  supabase: SupabaseClient,
  params: RecordInvoicePaymentRowParams,
): Promise<RecordInvoicePaymentRowResult> {
  const { userId, companyId, invoice, paymentDate, newPaidAmount, journalEntryId } = params

  const { data, error } = await supabase
    .from('invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_id: invoice.id,
      payment_date: paymentDate,
      amount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
      currency: invoice.currency ?? 'SEK',
      exchange_rate: invoice.exchange_rate ?? null,
      journal_entry_id: journalEntryId,
    })
    .select('id')
    .single()

  if (error || !data) {
    log.error('invoice_payments insert failed', error ?? undefined, {
      companyId,
      invoiceId: invoice.id,
      journalEntryId,
    })
    return {
      ok: false,
      error: error?.message ?? 'no_row_returned',
      ...(error?.code ? { code: error.code } : {}),
    }
  }
  return { ok: true, id: (data as { id: string }).id }
}

/**
 * Take the row back out when the settlement fails after it was written.
 * Never throws: the caller is already on its own error path. A row left
 * behind reads as a payment, so a failure is logged at error level.
 *
 * @returns true when the row is gone, false when it may be stranded.
 */
export async function removeInvoicePaymentRow(
  supabase: SupabaseClient,
  companyId: string,
  paymentRowId: string | null,
): Promise<boolean> {
  if (!paymentRowId) return true
  const ctx = { companyId, invoicePaymentId: paymentRowId }
  try {
    const { error } = await supabase
      .from('invoice_payments')
      .delete()
      .eq('id', paymentRowId)
      .eq('company_id', companyId)
    if (error) {
      log.error('invoice_payments rollback failed (row may be stranded)', error, ctx)
      return false
    }
    return true
  } catch (err) {
    log.error('invoice_payments rollback threw (row may be stranded)', err as Error, ctx)
    return false
  }
}
