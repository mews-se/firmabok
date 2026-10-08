import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateInvoiceCashEntry(...args),
}))

const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) =>
    mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) =>
    mockFindFiscalPeriod(...args),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it('returns 400 when invoice is in draft status', async () => {
    const invoice = makeInvoice({ status: 'draft' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is already paid', async () => {
    const invoice = makeInvoice({ status: 'paid' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is credited', async () => {
    const invoice = makeInvoice({ status: 'credited' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body: _body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
  })

  it('rejects a sent credit note before booking a payment', async () => {
    const invoice = makeInvoice({
      status: 'sent',
      credited_invoice_id: 'original-invoice-1',
    })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: unknown } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_NOT_PAYABLE')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects an original invoice while an active credit-note draft exists', async () => {
    const invoice = {
      ...makeInvoice({ status: 'sent', credited_invoice_id: null }),
      credit_notes: [{ id: 'credit-1', status: 'draft', creation_complete: true }],
    }
    enqueue({ data: invoice, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_NOT_PAYABLE')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('marks sent invoice as paid with accrual method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings (now before update due to journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { payment_date: '2026-05-12' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string | null
      paid_at: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')
    expect(body.paid_at).toBe('2026-05-12T12:00:00Z')
    // invoice.paid must fire so registered webhooks fan out (issue #825).
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        paymentAmount: 12500,
        invoice: expect.objectContaining({
          id: 'inv-1',
          status: 'paid',
          paid_amount: 12500,
          remaining_amount: 0,
          paid_at: '2026-05-12T12:00:00Z',
        }),
      }),
    )
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      undefined,
      expect.anything(),
      undefined, // paymentAmount: full settle
      undefined // settlementAccountNumber: default 1930
    )
  })

  it('refuses to mark paid (INVOICE_PAID_BOOK_FAILED) when no payment journal entry is produced', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Company settings
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Deliberately NO status-update enqueued: the route must fail closed BEFORE
    // touching the invoice row when nothing was booked.

    // Helper returns null without throwing (e.g. a closed/locked fiscal period).
    mockCreateInvoicePaymentJournalEntry.mockResolvedValue(null)

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    // No silent "paid with no journal entry": GL must not diverge from the AR ledger.
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
  })

  it('returns INVOICE_PAID_BOOK_FAILED without the driver text when the payment row cannot be saved', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: null, error: { message: 'new row violates row-level security policy', code: '42501' } })

    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-2' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
    expect(body.error.details).toEqual({ reason: 'payment_row_insert_failed' })
    expect(JSON.stringify(body)).not.toContain('row-level security')
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  it('marks overdue invoice as paid with cash method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'overdue',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-2' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-2')
    expect(mockCreateInvoiceCashEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      'enskild_firma',
      expect.anything(),
      undefined // settlementAccountNumber: default 1930
    )
  })

  it('returns 500 when journal entry creation fails (invoice not marked paid)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockRejectedValueOnce(new Error('Period locked'))

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('uses custom lines when provided instead of auto-generating', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings (before update, journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-custom' })

    const customLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0, line_description: 'Betalning' },
      { account_number: '1510', debit_amount: 0, credit_amount: 12500, line_description: 'Betalning' },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: customLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-custom')
    // Should NOT call auto-generation functions
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
    // Should call createJournalEntry directly with custom lines
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        entry_date: '2025-03-17',
        source_type: 'invoice_paid',
        lines: customLines,
      })
    )
  })

  it('returns 400 when custom lines are unbalanced', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const unbalancedLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 10000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: unbalancedLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when body has invalid schema (e.g. bad account number)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: [
          { account_number: 'XXXX', debit_amount: 12500, credit_amount: 0 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('books a partial payment from custom lines (lines total < remaining)', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-partial' })

    const partialLines = [
      { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 5000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: partialLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      paid_at: string | null
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-partial')
    // A 5000 payment on a 12500 invoice → partially_paid, remaining 7500.
    expect(body.status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(7500)
    expect(body.paid_at).toBeNull()
  })

  it('accepts an öresavrundning overshoot: rounded "Att betala" settles the invoice in full', async () => {
    // Invoice stored with öre (1234.75), PDF shows the rounded 1235.00 and the
    // customer pays that: the 3740 line carries the 0.25 residual.
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 1234.75,
      remaining_amount: 1234.75,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS update matched

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-ore' })

    const oreLines = [
      { account_number: '1930', debit_amount: 1235, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1234.75 },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: oreLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(1234.75)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-ore')
  })

  it('returns 400 MATCH_AMOUNT_EXCEEDS_REMAINING when custom lines overpay the invoice', async () => {
    // The overpayment guard must reject BEFORE any journal entry is created
    // (planInvoicePayment runs first).
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    enqueue({ data: invoice, error: null })

    const overpayLines = [
      { account_number: '1930', debit_amount: 15000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 15000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: overpayLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('falls back to auto-generation when lines are not provided', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-auto' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { payment_date: '2025-03-17' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-auto')
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Foreign-currency unit handling.
  // total / paid_amount / remaining_amount are stored in the INVOICE currency;
  // custom lines are journal lines and therefore SEK. Everything below pins
  // the conversion between the two.
  // ------------------------------------------------------------------

  it('converts a SEK custom-line payment to invoice currency before touching the ledger (EUR, partial)', async () => {
    // 1 000 EUR invoice at 11,4967 SEK/EUR. The customer pays 5 748,35 kr,
    // which is exactly 500 EUR: a genuine partial payment. Comparing the raw
    // 5 748,35 (SEK) against 1 000 (EUR) would read it as a full settlement.
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      currency: 'EUR',
      exchange_rate: 11.4967,
      total: 1000,
      remaining_amount: 1000,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-eur-partial' })
    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        lines: [
          { account_number: '1930', debit_amount: 5748.35, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 5748.35 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.status).toBe('partially_paid')
    // Both in EUR, never 5 748,35 and never a negative remainder.
    expect(body.paid_amount).toBe(500)
    expect(body.remaining_amount).toBe(500)
    expect(body.journal_entry_id).toBe('je-eur-partial')
    // The event carries the invoice-currency amount, matching the ledger.
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({ paymentAmount: 500 }),
    )
    // So does the payment row.
    expect(findCall('invoice_payments', 'insert')?.[0]).toMatchObject({
      amount: 500,
      currency: 'EUR',
      exchange_rate: 11.4967,
      journal_entry_id: 'je-eur-partial',
    })
  })

  it('returns 400 MATCH_INVOICE_BOOKING_RATE_MISSING when a EUR invoice carries no exchange rate', async () => {
    // 11 496,70 kr against a 1 000 EUR invoice with no rate on file. Defaulting
    // the rate to 1 would read the payment as 11 496,70 EUR.
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      currency: 'EUR',
      exchange_rate: null,
      total: 1000,
      remaining_amount: 1000,
    })

    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        lines: [
          { account_number: '1930', debit_amount: 11496.7, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 11496.7 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: unknown } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_BOOKING_RATE_MISSING')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a sub-remaining SEK payment on a rate-less EUR invoice instead of booking kronor as euro', async () => {
    // The silent-corruption direction: 500 kr against a 1 000 EUR invoice sits
    // below the invoice-currency remaining, so no overpayment guard catches it.
    // With a rate-1 fallback it recorded 500 EUR paid and left 500 EUR
    // remaining, when the customer had really paid ~43 EUR.
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      currency: 'EUR',
      exchange_rate: null,
      total: 1000,
      remaining_amount: 1000,
    })

    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        lines: [
          { account_number: '1930', debit_amount: 500, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 500 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_BOOKING_RATE_MISSING')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('leaves a rate-less EUR invoice payable when no custom lines are supplied', async () => {
    // The default path pays remaining_amount, which is already in invoice
    // currency: no conversion happens, so no rate is required.
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      currency: 'EUR',
      exchange_rate: null,
      total: 1000,
      remaining_amount: 1000,
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: { id: 'ip-1' }, error: null }) // payment row
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-eur-full' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      status: string
      paid_amount: number
      remaining_amount: number
    }>(response)

    expect(status).toBe(200)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(1000)
    expect(body.remaining_amount).toBe(0)
  })
})
