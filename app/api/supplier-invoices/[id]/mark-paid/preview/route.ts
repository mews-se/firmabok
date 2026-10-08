/**
 * GET /api/supplier-invoices/[id]/mark-paid/preview?amount=...&payment_account=...
 *
 * Read-only preview of the journal entry mark-paid would post. Mirrors the
 * POST handler's routing: if the SI has a registration JE, payment clears
 * 2440. Otherwise (kontantmetoden + never booked), expense + input VAT
 * book here, with the lines from the same builder the POST handler books.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { planCashInstalment } from '@/lib/bookkeeping/cash-instalment'
import {
  buildSupplierInvoiceCashLines,
  SupplierInvoiceFxRateMissingError,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

const QuerySchema = z.object({
  amount: z.coerce.number().positive(),
  payment_account: z.string().min(1).optional(),
})

export const GET = withRouteContext(
  'supplier_invoice.mark_paid_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({
      amount: url.searchParams.get('amount'),
      payment_account: url.searchParams.get('payment_account') ?? undefined,
    })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const { amount, payment_account } = parsed.data

    const { data: invoice, error: invErr } = await supabase
      .from('supplier_invoices')
      // supplier_type drives the reverse-charge lines, as in the POST handler
      .select('*, supplier:suppliers(supplier_type, name), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()
    if (invErr || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, last_supplier_payment_account')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const creditAccount =
      payment_account ||
      (settings as { last_supplier_payment_account?: string } | null)?.last_supplier_payment_account ||
      '1930'

    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // Same plan and refusals as the POST handler, so the preview never shows
    // lines it will not book.
    const cashPlan =
      useCashEntry && (invoice.currency || 'SEK') === 'SEK'
        ? planCashInstalment(invoice, amount)
        : null
    if (cashPlan?.kind === 'overpayment') {
      return errorResponseFromCode('SI_CASH_OVERPAYMENT_UNSUPPORTED', log, {
        requestId,
        details: { excess: cashPlan.difference },
      })
    }
    const remainingForGuard =
      (invoice as { remaining_amount?: number | null }).remaining_amount ?? invoice.total
    const cashBlock = cashPlan
      ? null
      : cashPartialBlockReason({
          invoiceAlreadyBooked: siAlreadyBooked,
          accountingMethod,
          priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
          paysRemainingInFull: amount >= remainingForGuard - 0.005,
        })
    if (cashBlock) {
      return errorResponseFromCode('SI_CASH_PARTIAL_UNSUPPORTED', log, {
        requestId,
        details: { reason: cashBlock },
      })
    }

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'

    if (useCashEntry) {
      entryType = 'cash'
      const si = invoice as SupplierInvoice & {
        items?: SupplierInvoiceItem[]
        supplier?: { supplier_type?: string | null; name?: string | null } | null
      }
      try {
        const built = buildSupplierInvoiceCashLines(
          si,
          si.items ?? [],
          si.supplier?.supplier_type || 'swedish_business',
          {
            supplierName: si.supplier?.name ?? undefined,
            paymentAccount: creditAccount,
            ...(cashPlan ? { paymentAmount: amount, priorPaidAmount: cashPlan.priorPaid } : {}),
          },
        )
        for (const l of built.lines) {
          lines.push({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
          })
        }
      } catch (err) {
        if (err instanceof SupplierInvoiceFxRateMissingError) {
          return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
            requestId,
            details: { invoice_currency: si.currency },
          })
        }
        throw err
      }
    } else {
      const rounded = Math.round(amount * 100) / 100
      lines.push({
        account_number: '2440',
        debit_amount: rounded,
        credit_amount: 0,
        description: 'Kvittning leverantörsskuld',
      })
      lines.push({
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: rounded,
        description: 'Utbetalning',
      })
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: siAlreadyBooked,
      accounting_method: accountingMethod,
    })
  },
)
