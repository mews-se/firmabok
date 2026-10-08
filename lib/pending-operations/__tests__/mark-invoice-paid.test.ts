/**
 * State + event coverage for the agent/MCP mark-invoice-paid commit path
 * (`commitMarkInvoicePaid` in lib/pending-operations/commit.ts).
 *
 * Regression guard for issue #825: this path previously flipped status to
 * 'paid' and set paid_amount = total but never wrote remaining_amount (leaving
 * it at the original total) and never emitted invoice.paid (so webhooks never
 * fired). It settles through settleInvoicePayment, the same service as the
 * dashboard mark-paid route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCustomer,
  makeInvoice,
} from '@/tests/helpers'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import type { PendingOperation } from '@/types'

const mockCreatePaymentEntry = vi.fn()
const mockCreateCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
    '@/lib/bookkeeping/invoice-entries',
  )
  return {
    ...actual,
    createInvoicePaymentJournalEntry: (...args: unknown[]) => mockCreatePaymentEntry(...args),
    createInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args),
  }
})

// the dashboard route, for the parity tests below
let routeSupabase: unknown
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(routeSupabase),
}))
vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { commitPendingOperation } from '../commit'
import { POST as markPaidRoute } from '@/app/api/invoices/[id]/mark-paid/route'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'mark_invoice_paid',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-1' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-1' })
})

describe('commitPendingOperation: mark_invoice_paid state + invoice.paid', () => {
  it('rejects credit notes before creating a payment journal entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'credit-1',
        invoice_number: 'KR-F-2026001',
        status: 'sent',
        total: -525,
        remaining_amount: -525,
        paid_amount: null,
        credited_invoice_id: 'inv-1',
        document_type: 'invoice',
        journal_entry_id: 'je-credit',
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'credit-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
  })

  it('zeroes remaining_amount and emits invoice.paid on full payment (issue #825)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // invoice CAS update
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'paid', remaining_amount: 0, journal_entry_id: 'je-1' })

    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        paymentAmount: 525,
        invoice: expect.objectContaining({
          id: 'inv-1',
          status: 'paid',
          remaining_amount: 0,
          paid_amount: 525,
          paid_at: '2026-03-30T12:00:00Z',
        }),
      }),
    )
    const invoiceUpdate = findCalls('invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-03-30T12:00:00Z' })
    expect(findCalls('invoice_payments', 'insert')[0]?.[0]).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      invoice_id: 'inv-1',
      payment_date: '2026-03-30',
      amount: 525,
      currency: 'SEK',
      exchange_rate: null,
      journal_entry_id: 'je-1',
    })
  })

  // No partial-payment counterpart here: this executor always settles the full
  // remaining balance (no custom amount param), so newStatus is always 'paid'.
  // The partial case is pinned on the surfaces that can produce it, e.g.
  // lib/invoices/__tests__/settle-invoice-payment.test.ts.
})

describe('commitPendingOperation: mark_invoice_paid failures', () => {
  function enqueueUnpaidInvoice(enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue']) {
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: '2026001',
        status: 'sent',
        total: 525,
        remaining_amount: 525,
        paid_amount: null,
        document_type: 'invoice',
        journal_entry_id: null,
        customer: { name: 'Test AB' },
      },
      error: null,
    }) // invoice fetch
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null }) // settings
  }

  it('lets a bookkeeping error reach the dispatcher so the claim is released', async () => {
    mockCreateCashEntry.mockRejectedValue(new AccountsNotInChartError(['3001']))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnpaidInvoice(enqueue)
    enqueue({ data: null, error: null }) // dispatcher releases the claim

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({ status: 'failed', http_status: 400, code: 'ACCOUNTS_NOT_IN_CHART' })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toEqual({ status: 'pending' })
    expect(findCalls('invoices', 'update')).toEqual([])
  })

  it('reports a throwing entry helper with its own message', async () => {
    mockCreateCashEntry.mockRejectedValue(new Error('Period locked'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnpaidInvoice(enqueue)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({ status: 'failed', http_status: 500, error: 'Period locked' })
    expect(findCalls('pending_operations', 'update').at(-1)?.[0]).toMatchObject({
      status: 'rejected',
      result_data: { error: 'Period locked', threw: true },
    })
  })

  it('refuses with 422 when no voucher is created', async () => {
    mockCreateCashEntry.mockResolvedValue(null)
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnpaidInvoice(enqueue)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({ status: 'failed', http_status: 422 })
    expect(result.error).toContain('ingen verifikation skapades')
    expect(findCalls('invoice_payments', 'insert')).toEqual([])
    expect(findCalls('invoices', 'update')).toEqual([])
  })

  it('cancels the voucher and fails when the payment row cannot be saved', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnpaidInvoice(enqueue)
    enqueue({ data: null, error: { message: 'insert failed' } }) // payment row
    enqueue({ data: { fiscal_period_id: 'fp-1', voucher_series: 'A', voucher_number: 7 }, error: null }) // orphan read
    enqueue({ data: null, error: null }) // orphan cancel
    enqueue({ data: null, error: null }) // gap explanation
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { invoice_id: 'inv-1', payment_date: '2026-03-30' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({ status: 'failed', http_status: 500 })
    expect(result.error).toContain('kundreskontran')
    expect(findCalls('journal_entries', 'update')[0]?.[0]).toEqual({ status: 'cancelled' })
    expect(findCalls('invoices', 'update')).toEqual([])
  })
})

describe('mark-paid parity: MCP executor and dashboard route', () => {
  const customer = makeCustomer({ name: 'Kund AB' })

  async function settleBothWays(invoice: ReturnType<typeof makeInvoice>, accountingMethod: string) {
    const queued = createQueuedMockSupabase()
    queued.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
    routeSupabase = queued.supabase
    const settings = { accounting_method: accountingMethod, entity_type: 'enskild_firma' }

    queued.enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    queued.enqueue({ data: invoice, error: null })
    queued.enqueue({ data: settings, error: null })
    queued.enqueue({ data: { id: 'ip-mcp' }, error: null }) // payment row
    queued.enqueue({ data: [{ id: invoice.id }], error: null }) // invoice CAS update
    queued.enqueue({ data: null, error: null }) // dispatcher pending_operations update
    const op = makePendingOp({ params: { invoice_id: invoice.id, payment_date: '2027-03-20' } })
    const mcp = await commitPendingOperation(queued.supabase as never, 'user-1', 'company-1', op)

    queued.enqueue({ data: invoice, error: null })
    queued.enqueue({ data: settings, error: null })
    queued.enqueue({ data: { id: 'ip-web' }, error: null }) // payment row
    queued.enqueue({ data: [{ id: invoice.id }], error: null }) // invoice CAS update
    const request = createMockRequest(`/api/invoices/${invoice.id}/mark-paid`, {
      method: 'POST',
      body: { payment_date: '2027-03-20' },
    })
    const web = await markPaidRoute(request, createMockRouteParams({ id: invoice.id }))

    return { mcp, web, rows: queued.findCalls('invoice_payments', 'insert').map((args) => args[0]) }
  }

  it('books a kontantmetod invoice with the same cash entry and the same row', async () => {
    mockCreateCashEntry.mockResolvedValue({ id: 'je-cash' })
    const invoice = makeInvoice({
      id: 'inv-cash',
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      journal_entry_id: null,
      customer,
    } as Partial<ReturnType<typeof makeInvoice>>)

    const { mcp, web, rows } = await settleBothWays(invoice, 'cash')

    expect(mcp.status).toBe('committed')
    expect(web.status).toBe(200)
    expect(mockCreateCashEntry).toHaveBeenCalledTimes(2)
    expect(mockCreateCashEntry.mock.calls[0]).toEqual(mockCreateCashEntry.mock.calls[1])
    expect(mockCreateCashEntry.mock.calls[0].slice(1)).toEqual([
      'company-1', 'user-1', invoice, '2027-03-20', 'enskild_firma', 'Kund AB', undefined,
    ])
    expect(mockCreatePaymentEntry).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(rows[1])
    expect(rows[0]).toMatchObject({ amount: 12500, payment_date: '2027-03-20', journal_entry_id: 'je-cash' })
  })

  it('books a faktureringsmetod invoice with the same clearing entry and the same row', async () => {
    mockCreatePaymentEntry.mockResolvedValue({ id: 'je-clear' })
    const invoice = makeInvoice({
      id: 'inv-accrual',
      status: 'overdue',
      total: 12500,
      remaining_amount: 12500,
      journal_entry_id: 'je-orig',
      customer,
    } as Partial<ReturnType<typeof makeInvoice>>)

    const { mcp, web, rows } = await settleBothWays(invoice, 'accrual')

    expect(mcp.status).toBe('committed')
    expect(web.status).toBe(200)
    expect(mockCreatePaymentEntry).toHaveBeenCalledTimes(2)
    expect(mockCreatePaymentEntry.mock.calls[0]).toEqual(mockCreatePaymentEntry.mock.calls[1])
    expect(mockCreatePaymentEntry.mock.calls[0].slice(1)).toEqual([
      'company-1', 'user-1', invoice, '2027-03-20', undefined, 'Kund AB', undefined, undefined,
    ])
    expect(mockCreateCashEntry).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(rows[1])
    expect(rows[0]).toMatchObject({ amount: 12500, journal_entry_id: 'je-clear' })
  })
})
