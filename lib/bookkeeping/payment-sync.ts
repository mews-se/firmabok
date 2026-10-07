import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { JournalEntry } from '@/types'

const log = createLogger('payment-sync')

export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * that a payment journal entry was attached to. Used by both reverseEntry()
 * (storno) and the DELETE journal entry route: both paths leave the GL in a
 * consistent state but the invoice's status/paid_amount/paid_at would otherwise
 * stay stuck on "paid".
 *
 * Safe to call with any entry: returns early if source_type is not a payment.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
): Promise<void> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return

  const entryId = entry.id

  if (entry.source_type.startsWith('supplier_invoice')) {
    // Scope to THIS invoice's payment row: a batch voucher (match_batch_allocate)
    // carries one payment row per invoice under the same journal_entry_id, so an
    // unfiltered .single() errors out on multi-row and silently yields null.
    const { data: payment } = await supabase
      .from('supplier_invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('supplier_invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    // Column is `total`, not `total_amount` (supplier_invoices has never had a
    // total_amount column). Selecting the wrong name made PostgREST reject the
    // whole query, so `supplierInvoice` was always null: the restore below was
    // silently skipped while the payment-row delete still ran. The invoice then
    // stayed 'paid' with a stale paid_amount and nothing behind it, so the AP
    // ledger (leverantörsreskontra) showed money as paid that was never paid.
    const { data: supplierInvoice, error: supplierInvoiceError } = await supabase
      .from('supplier_invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    // PGRST116 = no row: the invoice itself is gone, so there is nothing to
    // restore and the cleanup below is still the right thing to do. Any OTHER
    // error means we could not read the state we are about to overwrite.
    // Deleting the payment row at that point would destroy the only evidence
    // of the payment while the invoice stays 'paid': exactly the wrong-AP-ledger
    // outcome above. Abort instead, at ERROR level so the failure is
    // observable: the storno is already committed and both callers
    // (reverseEntry, the DELETE voucher route) treat this sync as best-effort,
    // so bailing out leaves invoice + payment row mutually consistent and the
    // operation safely re-runnable.
    if (supplierInvoiceError && supplierInvoiceError.code !== 'PGRST116') {
      log.error(
        'Failed to read supplier invoice for payment reversal: aborting status sync',
        supplierInvoiceError,
        { companyId, journalEntryId: entryId, supplierInvoiceId: entry.source_id }
      )
      return
    }

    if (supplierInvoice) {
      // Same fallback semantics as the customer branch below: a cash payment
      // (supplier_invoice_cash_payment) books no payment row and is only ever
      // a FULL payment, so reverting the whole paid_amount is correct. The
      // old `&& payment` guard skipped the restore entirely for cash
      // reversals, leaving the supplier invoice deadlocked on 'paid'.
      const paymentAmount = payment?.amount ?? supplierInvoice.paid_amount
      const newPaidAmount = roundOre(supplierInvoice.paid_amount - paymentAmount)
      const newRemaining = roundOre(supplierInvoice.total - Math.max(0, newPaidAmount))
      let newStatus: string
      if (newPaidAmount > 0) {
        newStatus = 'partially_paid'
      } else if (supplierInvoice.due_date && new Date(supplierInvoice.due_date) < new Date()) {
        newStatus = 'overdue'
      } else {
        newStatus = 'approved'
      }

      await supabase
        .from('supplier_invoices')
        .update({
          status: newStatus,
          paid_amount: Math.max(0, newPaidAmount),
          remaining_amount: newRemaining,
          paid_at: null,
          payment_journal_entry_id: null,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // later payment doesn't double-count or trip the unique index on
    // supplier_invoice_payments. Scoped to the source invoice: a batch voucher
    // carries sibling rows for other invoices whose status this call does not
    // restore, so deleting them here would desync paid_amount from the payment
    // rows (PR #666 review, SOC 2 CC6.3).
    await supabase
      .from('supplier_invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('supplier_invoice_id', entry.source_id)
      .eq('company_id', companyId)
  } else {
    // Scoped like the supplier branch: filter by invoice_id + company_id so a
    // batch voucher's sibling payment rows don't break the .single().
    const { data: payment } = await supabase
      .from('invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    const { data: customerInvoice } = await supabase
      .from('invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (customerInvoice) {
      // For a partial reversal we take the exact amount from the payment row.
      // The fallback (full paid_amount) only applies when no payment row exists:
      // true for invoice_cash_payment, which is only ever booked on a FULL
      // payment, so reverting the whole paid_amount is correct there. Guarding
      // this keeps a future partial-cash path from over-reverting.
      const paymentAmount = payment?.amount ?? customerInvoice.paid_amount
      const newPaidAmount = roundOre(customerInvoice.paid_amount - paymentAmount)
      const safePaidAmount = Math.max(0, newPaidAmount)
      // The supplier branch already resets remaining_amount; the customer branch
      // never did, leaving it stale (= total) after a reversal so the invoice
      // showed fully unpaid yet stuck on 'paid'. Recompute from total. (The
      // .in('status', …) guard below can leave status/remaining un-updated if
      // the invoice isn't paid/partially_paid: only reachable on a non-storno
      // path; the payment-row delete still runs.)
      const newRemaining = roundOre(customerInvoice.total - safePaidAmount)
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      await supabase
        .from('invoices')
        .update({
          status: revertStatus,
          paid_at: null,
          paid_amount: safePaidAmount,
          remaining_amount: newRemaining,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
        .in('status', ['paid', 'partially_paid'])
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // later payment doesn't trip the (journal_entry_id, invoice_id) unique
    // index on invoice_payments. Scoped to the source invoice: see the
    // supplier branch comment for the batch-voucher rationale.
    await supabase
      .from('invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)
  }
}
