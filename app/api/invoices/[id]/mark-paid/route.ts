import { NextResponse } from 'next/server'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { roundOre } from '@/lib/money'
import type { EntityType, Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank sync).
 *
 * Faktureringsmetoden (accrual): Debit 1930, Credit 1510 (clearing entry)
 * Kontantmetoden (cash):         Debit 1930, Credit 30xx, Credit 26xx
 *
 * The booking + status transition live in settleInvoicePayment; this route
 * owns request parsing and the payable guard.
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (invoice.credited_invoice_id) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { reason: 'credit_note' },
      })
    }

    const activeCreditNotes = ((invoice as { credit_notes?: Array<{
      status: string
      creation_complete?: boolean
    }> }).credit_notes ?? []).filter(
      (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
    )
    if (activeCreditNotes.length > 0) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { reason: 'active_credit_note' },
      })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let rawBody: unknown
    try {
      const text = await request.text()
      if (text) rawBody = JSON.parse(text)
    } catch {
      // Empty / invalid body: fall through to defaults.
    }

    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        opLog.warn('mark-paid validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
    }

    const now = new Date().toISOString()
    const paymentDate = bodyPaymentDate || now.split('T')[0]

    const invForRemaining = invoice as Invoice & {
      remaining_amount?: number | null
      paid_amount?: number | null
    }
    const remainingAmount =
      invForRemaining.remaining_amount ?? invoice.total - (invForRemaining.paid_amount ?? 0)
    const paymentAmount = customLines
      ? customLines.reduce((s, l) => s + l.debit_amount, 0)
      : remainingAmount

    // Unit contract: total / paid_amount / remaining_amount are stored in the
    // INVOICE currency (total_sek carries the SEK view of total); custom lines
    // are journal lines, so they are always SEK. The SEK amount therefore has
    // to be converted before it is compared against, or subtracted from, the
    // invoice-currency remaining. The default path (no lines) already pays the
    // remaining in invoice currency and needs no rate at all.
    const isForeignCurrency = !!invoice.currency && invoice.currency !== 'SEK'
    const needsFxConversion = isForeignCurrency && customLines !== undefined
    const fxRate =
      invoice.exchange_rate && invoice.exchange_rate > 0 ? invoice.exchange_rate : null
    if (needsFxConversion && fxRate === null) {
      // Never fall back to rate 1: that reads an 11 496,70 kr payment against a
      // 1 000 EUR invoice as 11 496,70 EUR and corrupts the AR sub-ledger.
      // Same code as buildInvoicePaymentClearingLines' refusal
      // (MATCH_INVOICE_BOOKING_RATE_MISSING, lib/bookkeeping/invoice-payment-lines.ts):
      // one condition, one code across every invoice-settlement surface.
      opLog.warn('mark-paid rejected: foreign-currency invoice without exchange rate', {
        invoiceId: id,
        currency: invoice.currency,
      })
      return errorResponseFromCode('MATCH_INVOICE_BOOKING_RATE_MISSING', opLog, {
        requestId,
        details: { invoice_id: id, currency: invoice.currency },
      })
    }
    const paymentAmountInInvoiceCurrency = needsFxConversion
      ? roundOre(paymentAmount / fxRate!)
      : paymentAmount

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    const result = await settleInvoicePayment(supabase, companyId!, user.id, {
      invoice: invoice as Invoice & { customer?: { name?: string | null } | null },
      paymentAmountInInvoiceCurrency,
      paymentDate,
      accountingMethod,
      entityType,
      exchangeRateDifference,
      customLines,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'BOOKKEEPING_ERROR':
          return errorResponse(result.error, opLog, { requestId })
        case 'UPDATE_FAILED':
          opLog.error('failed to update invoice status', result.error as Error)
          return errorResponse(result.error, opLog, { requestId })
        case 'INVOICE_PAID_BOOK_FAILED':
          opLog.error('failed to create payment journal entry', undefined, {
            details: result.details,
          })
          return errorResponseFromCode(result.code, opLog, {
            requestId,
            details: result.details,
          })
        case 'INVOICE_PAID_RACE':
          return errorResponseFromCode(result.code, opLog, { requestId })
        default:
          return errorResponseFromCode(result.code, opLog, {
            requestId,
            details: result.details,
          })
      }
    }

    return NextResponse.json({
      success: true,
      status: result.newStatus,
      paid_at: result.paidAt,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      journal_entry_id: result.journalEntryId,
    })
  },
  { requireWrite: true },
)
