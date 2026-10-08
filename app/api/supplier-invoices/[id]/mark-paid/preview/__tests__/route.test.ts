import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'
import type { CreateJournalEntryInput, Supplier, SupplierInvoice, SupplierInvoiceItem } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))

import { eventBus } from '@/lib/events'
import { GET } from '../route'
import { POST } from '../../route'

type Line = { account_number: string; debit_amount: number; credit_amount: number; description: string }

function item(overrides: Partial<SupplierInvoiceItem>): SupplierInvoiceItem {
  const lineTotal = overrides.line_total ?? 8000
  const vatRate = overrides.vat_rate ?? 0.25
  return {
    id: `item-${overrides.sort_order ?? 0}`,
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Rad',
    quantity: 1,
    unit: 'st',
    unit_price: lineTotal,
    line_total: lineTotal,
    account_number: '6540',
    vat_code: null,
    vat_rate: vatRate,
    vat_amount: Math.round(lineTotal * vatRate * 100) / 100,
    reverse_charge_rate: null,
    created_at: '2027-03-01T00:00:00Z',
    ...overrides,
  }
}

function cashInvoice(
  items: SupplierInvoiceItem[],
  overrides: Partial<SupplierInvoice> = {},
  supplier: Supplier = makeSupplier({ name: 'Leverantör AB' }),
) {
  const subtotal = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100
  const vat = overrides.reverse_charge
    ? 0
    : Math.round(items.reduce((s, i) => s + i.vat_amount, 0) * 100) / 100
  const total = Math.round((subtotal + vat) * 100) / 100
  return {
    ...makeSupplierInvoice({
      id: 'si-1',
      supplier_invoice_number: 'S-77',
      status: 'registered',
      subtotal,
      vat_amount: vat,
      total,
      remaining_amount: total,
      paid_amount: 0,
      ...overrides,
    }),
    supplier,
    items,
  }
}

const SETTINGS = { accounting_method: 'cash', last_supplier_payment_account: '1930' }

async function preview(invoice: ReturnType<typeof cashInvoice>, amount = invoice.total): Promise<Line[]> {
  enqueue({ data: invoice })
  enqueue({ data: SETTINGS })
  const res = await GET(
    createMockRequest('/api/supplier-invoices/si-1/mark-paid/preview', {
      searchParams: { amount: String(amount), payment_account: '1930' },
    }),
    createMockRouteParams({ id: 'si-1' }),
  )
  const { status, body } = await parseJsonResponse<{ entry_type: string; lines: Line[] }>(res)
  expect(status).toBe(200)
  expect(body.entry_type).toBe('cash')
  return body.lines
}

async function booked(invoice: ReturnType<typeof cashInvoice>, amount = invoice.total): Promise<Line[]> {
  enqueue({ data: invoice })
  enqueue({ data: SETTINGS })
  enqueue({ data: [{ id: 'si-1' }] })
  enqueue({ data: null })
  const res = await POST(
    createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
      method: 'POST',
      body: { amount, payment_date: '2027-03-25', payment_account: '1930' },
    }),
    createMockRouteParams({ id: 'si-1' }),
  )
  expect(res.status).toBe(200)
  const input = mockCreateJournalEntry.mock.calls.at(-1)?.[3] as CreateJournalEntryInput
  expect(input.source_type).toBe('supplier_invoice_cash_payment')
  return input.lines.map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    description: l.line_description ?? '',
  }))
}

describe('GET /api/supplier-invoices/[id]/mark-paid/preview under kontantmetoden', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockCreateJournalEntry.mockImplementation(async () => ({ id: 'je-1' }))
  })

  it('shows the cost account and the gross payment, not 4000 and the net', async () => {
    const invoice = cashInvoice([item({ line_total: 8000, account_number: '6540' })])

    const lines = await preview(invoice)

    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 8000, 0],
      ['2641', 2000, 0],
      ['1930', 0, 10000],
    ])
    expect(lines).toEqual(await booked(invoice))
  })

  it('matches the booked lines for several cost accounts', async () => {
    const invoice = cashInvoice([
      item({ sort_order: 0, line_total: 1200, account_number: '5410' }),
      item({ sort_order: 1, line_total: 800, account_number: '6540' }),
      item({ sort_order: 2, line_total: 300, account_number: '5410' }),
    ])

    const lines = await preview(invoice)

    expect(lines.find((l) => l.account_number === '5410')?.debit_amount).toBe(1500)
    expect(lines).toEqual(await booked(invoice))
  })

  it('matches the booked lines for mixed VAT rates', async () => {
    const invoice = cashInvoice([
      item({ sort_order: 0, line_total: 1000, vat_rate: 0.25, account_number: '6540' }),
      item({ sort_order: 1, line_total: 500, vat_rate: 0.12, account_number: '5460' }),
      item({ sort_order: 2, line_total: 200, vat_rate: 0.06, account_number: '6970' }),
    ])

    const lines = await preview(invoice)

    expect(lines.filter((l) => l.account_number === '2641').map((l) => l.debit_amount)).toEqual([250, 60, 12])
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(2022)
    expect(lines).toEqual(await booked(invoice))
  })

  it('matches the booked lines under reverse charge', async () => {
    const invoice = cashInvoice(
      [item({ line_total: 10000, vat_rate: 0, vat_amount: 0, account_number: '6540' })],
      { reverse_charge: true, vat_treatment: 'reverse_charge' },
      makeSupplier({ name: 'EU Supplier GmbH', supplier_type: 'eu_business' }),
    )

    const lines = await preview(invoice)

    expect(lines.find((l) => l.account_number === '2645')?.debit_amount).toBe(2500)
    expect(lines.find((l) => l.account_number === '2614')?.credit_amount).toBe(2500)
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(10000)
    expect(lines).toEqual(await booked(invoice))
  })

  it('matches the booked lines with öresavrundning on', async () => {
    const invoice = cashInvoice([item({ line_total: 987.65, account_number: '6540' })], {
      ore_rounding: true,
    })

    expect(await preview(invoice)).toEqual(await booked(invoice))
  })

  it('matches the booked lines with an avrundning row on 3740', async () => {
    const invoice = cashInvoice([
      item({ sort_order: 0, line_total: 16000, account_number: '6110' }),
      item({ sort_order: 1, line_total: 45, account_number: '3540' }),
      item({ sort_order: 2, line_total: -0.25, vat_rate: 0, account_number: '3740' }),
    ], { ore_rounding: true })

    const lines = await preview(invoice)

    expect(lines.find((l) => l.account_number === '3740')).toMatchObject({ debit_amount: 0, credit_amount: 0.25 })
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(20056)
    expect(lines).toEqual(await booked(invoice))
  })

  it('matches the booked lines for a partial payment and for the payment that completes it', async () => {
    const items = [item({ line_total: 8000, account_number: '6540' })]
    const unpaid = cashInvoice(items)
    const first = await preview(unpaid, 4000)

    expect(first.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 3200, 0],
      ['2641', 800, 0],
      ['1930', 0, 4000],
    ])
    expect(first).toEqual(await booked(unpaid, 4000))

    const partlyPaid = cashInvoice(items, { status: 'partially_paid', paid_amount: 4000, remaining_amount: 6000 })
    const last = await preview(partlyPaid, 6000)

    expect(last.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 4800, 0],
      ['2641', 1200, 0],
      ['1930', 0, 6000],
    ])
    expect(last).toEqual(await booked(partlyPaid, 6000))
  })

  it('matches the booked lines when the payment settles inside the öre band', async () => {
    const invoice = cashInvoice([item({ line_total: 987.65, account_number: '6540' })])

    const lines = await preview(invoice, 1235)

    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 987.65, 0],
      ['2641', 246.91, 0],
      ['1930', 0, 1235],
      ['3740', 0.44, 0],
    ])
    expect(lines).toEqual(await booked(invoice, 1235))
  })

  it('refuses to preview a payment 1 kr or more above the remaining amount', async () => {
    const invoice = cashInvoice([item({ line_total: 8000 })])
    enqueue({ data: invoice })
    enqueue({ data: SETTINGS })

    const res = await GET(
      createMockRequest('/api/supplier-invoices/si-1/mark-paid/preview', {
        searchParams: { amount: '10001', payment_account: '1930' },
      }),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_OVERPAYMENT_UNSUPPORTED')
  })

  it('refuses a foreign invoice without a rate instead of previewing it 1:1', async () => {
    const invoice = cashInvoice([item({ line_total: 1000 })], { currency: 'EUR', exchange_rate: null })
    enqueue({ data: invoice })
    enqueue({ data: SETTINGS })

    const res = await GET(
      createMockRequest('/api/supplier-invoices/si-1/mark-paid/preview', {
        searchParams: { amount: String(invoice.total), payment_account: '1930' },
      }),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
  })
})

describe('GET /api/supplier-invoices/[id]/mark-paid/preview for a booked invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  it('clears 2440 with the payment amount', async () => {
    const invoice = cashInvoice([item({ line_total: 8000 })], { registration_journal_entry_id: 'je-reg' })
    enqueue({ data: invoice })
    enqueue({ data: { accounting_method: 'accrual', last_supplier_payment_account: null } })

    const res = await GET(
      createMockRequest('/api/supplier-invoices/si-1/mark-paid/preview', {
        searchParams: { amount: '10000', payment_account: '1930' },
      }),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { status, body } = await parseJsonResponse<{ entry_type: string; lines: Line[] }>(res)

    expect(status).toBe(200)
    expect(body.entry_type).toBe('clearing')
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 10000, 0],
      ['1930', 0, 10000],
    ])
  })
})
