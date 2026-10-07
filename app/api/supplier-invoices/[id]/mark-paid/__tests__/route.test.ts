import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
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

const mockCreateSupplierInvoicePaymentEntry = vi.fn()
const mockCreateSupplierInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoicePaymentEntry(...args),
  createSupplierInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceCashEntry(...args),
}))

vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))

import { eventBus } from '@/lib/events'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/supplier-invoices/si-999/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('SI_NOT_FOUND')
  })

  it('returns 400 when invoice is in wrong status', async () => {
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'paid',
      supplier: makeSupplier(),
      items: [],
    })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('SI_PAID_NOT_PAYABLE')
  })

  it('marks as fully paid with accrual method', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    // Record payment
    enqueue({ data: null, error: null })

    const paidHandler = vi.fn()
    eventBus.on('supplier_invoice.paid', paidHandler)

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { payment_date: '2026-05-12' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
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
    expect(body.paid_amount).toBe(10000)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')
    expect(mockCreateSupplierInvoicePaymentEntry).toHaveBeenCalled()
    const invoiceUpdate = findCalls('supplier_invoices', 'update').at(-1)?.[0]
    expect(invoiceUpdate).toMatchObject({ paid_at: '2026-05-12T12:00:00Z' })
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        supplierInvoice: expect.objectContaining({ paid_at: '2026-05-12T12:00:00Z' }),
      }),
    )
  })

  it('marks as partially paid', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-2' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount: 5000 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(5000)
  })

  it('uses cash method journal entry when configured', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [
        {
          id: 'item-1',
          supplier_invoice_id: 'si-1',
          sort_order: 0,
          description: 'Material',
          quantity: 10,
          unit: 'st',
          unit_price: 800,
          line_total: 8000,
          account_number: '4010',
          vat_code: null,
          vat_rate: 0.25,
          vat_amount: 2000,
          reverse_charge_rate: null,
          created_at: '2024-06-01T00:00:00Z',
        },
      ],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    mockCreateSupplierInvoiceCashEntry.mockResolvedValue({ id: 'je-3' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-3')
    expect(mockCreateSupplierInvoiceCashEntry).toHaveBeenCalled()
    expect(mockCreateSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('rejects a cash-method partial payment on a never-booked supplier invoice', async () => {
    // createSupplierInvoiceCashEntry books the FULL invoice (all items + VAT)
    // and takes no payment amount, so a partial would over-book the expense.
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount: 4000 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
    expect(mockCreateSupplierInvoiceCashEntry).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoicePaymentEntry).not.toHaveBeenCalled()
  })

  it('rejects completing a previously part-paid never-booked cash supplier invoice', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'partially_paid',
      total: 10000,
      remaining_amount: 6000,
      paid_amount: 4000,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
    expect(mockCreateSupplierInvoiceCashEntry).not.toHaveBeenCalled()
  })

  it('cash method: anchors the invoice document to a posted verifikat (BFL 5 kap 6 §)', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      document_id: 'doc-1',
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    mockCreateSupplierInvoiceCashEntry.mockResolvedValue({ id: 'je-cash' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    // Record payment
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-cash')
    // The cash entry is the ONLY booking, so its underlag must hang on a
    // posted verifikat of this invoice. Which one it picks (and that it never
    // moves an already-anchored doc) is pinned in the helper's own tests.
    expect(anchorSupplierInvoiceDocument).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'si-1',
    )
  })

  it('accrual method: still delegates the anchor check (a no-op once the doc sits on the registration verifikat)', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      document_id: 'doc-1',
      registration_journal_entry_id: 'je-reg',
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-pay' })

    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    // Record payment
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // The document already lives on the registration verifikat, so the helper
    // leaves it there: it only ever anchors a FLOATING doc, which is the case
    // this route previously skipped entirely (leaving the payment verifikat
    // warning "Underlag saknas" with no way out).
    expect(anchorSupplierInvoiceDocument).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'si-1',
    )
  })

  it('returns 500 when journal entry creation fails (blocking: GL must succeed for payment)', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePaymentEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_PAID_FAILED')
  })

  it('marks as partially paid with an explicit amount below the remaining', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount: 3000 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ status: string }>(response)

    expect(status).toBe(200)
    expect(body.status).toBe('partially_paid')
  })

  it('emits supplier_invoice.paid event', async () => {
    const supplier = makeSupplier()
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      status: 'approved',
      total: 10000,
      remaining_amount: 10000,
      paid_amount: 0,
      supplier,
      items: [],
    })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoicePaymentEntry.mockResolvedValue({ id: 'je-1' })
    // Update invoice (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'si-1' }], error: null })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'si-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.paid',
        payload: expect.objectContaining({
          userId: 'user-1',
          paymentAmount: 10000,
        }),
      })
    )
  })
})
