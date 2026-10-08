import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    child: vi.fn().mockReturnThis(),
  }),
}))

import { recordInvoicePaymentRow, removeInvoicePaymentRow } from '../invoice-payment-row'

const BASE = {
  userId: 'user-1',
  companyId: 'company-1',
  paymentDate: '2027-03-20',
  journalEntryId: 'je-1',
}

describe('recordInvoicePaymentRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the full row for a first payment in SEK', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' } })

    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1', currency: 'SEK', exchange_rate: null, paid_amount: null },
      newPaidAmount: 12500,
    })

    expect(result).toEqual({ ok: true, id: 'ip-1' })
    expect(findCall('invoice_payments', 'insert')?.[0]).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      invoice_id: 'inv-1',
      payment_date: '2027-03-20',
      amount: 12500,
      currency: 'SEK',
      exchange_rate: null,
      journal_entry_id: 'je-1',
    })
  })

  it('stores the applied amount after a prior partial, not the new paid_amount', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-2' } })

    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1', currency: 'SEK', paid_amount: 500.1 },
      newPaidAmount: 1234.56,
    })

    expect(findCall('invoice_payments', 'insert')?.[0]).toMatchObject({ amount: 734.46 })
  })

  it('stores the remaining when an öre residual was absorbed (paid_amount, not the bank amount)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-3' } })

    // 1 235 kr reached the bank for 1 234,56; the plan advances paid_amount by
    // the remaining only and 3740 carries 0,44.
    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1', currency: 'SEK', paid_amount: 0 },
      newPaidAmount: 1234.56,
    })

    expect(findCall('invoice_payments', 'insert')?.[0]).toMatchObject({ amount: 1234.56 })
  })

  it('defaults currency to SEK and keeps the invoice exchange rate', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-4' } })
    enqueue({ data: { id: 'ip-5' } })

    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1' },
      newPaidAmount: 100,
    })
    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-2', currency: 'EUR', exchange_rate: 11.5, paid_amount: 0 },
      newPaidAmount: 1000,
    })

    const [first, second] = findCalls('invoice_payments', 'insert').map((args) => args[0])
    expect(first).toMatchObject({ currency: 'SEK', exchange_rate: null, amount: 100 })
    expect(second).toMatchObject({ currency: 'EUR', exchange_rate: 11.5, amount: 1000 })
  })

  it('returns the driver message and SQLSTATE on an insert error and logs it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'duplicate key value', code: '23505' } })

    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1' },
      newPaidAmount: 100,
    })

    expect(result).toEqual({ ok: false, error: 'duplicate key value', code: '23505' })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('fails when no row comes back', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...BASE,
      invoice: { id: 'inv-1' },
      newPaidAmount: 100,
    })

    expect(result).toEqual({ ok: false, error: 'no_row_returned' })
  })
})

describe('removeInvoicePaymentRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes the row by id within the company', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: null })

    const removed = await removeInvoicePaymentRow(
      supabase as unknown as SupabaseClient,
      'company-1',
      'ip-1',
    )

    expect(removed).toBe(true)
    const chain = calls.filter((c) => c.table === 'invoice_payments').map((c) => [c.method, ...c.args])
    expect(chain).toEqual([
      ['delete'],
      ['eq', 'id', 'ip-1'],
      ['eq', 'company_id', 'company-1'],
    ])
  })

  it('is a no-op without a row id', async () => {
    const { supabase } = createQueuedMockSupabase()

    const removed = await removeInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', null)

    expect(removed).toBe(true)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns false and logs when the delete fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'permission denied' } })

    const removed = await removeInvoicePaymentRow(
      supabase as unknown as SupabaseClient,
      'company-1',
      'ip-1',
    )

    expect(removed).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('rollback failed'),
      { message: 'permission denied' },
      { companyId: 'company-1', invoicePaymentId: 'ip-1' },
    )
  })

  it('never throws', async () => {
    const supabase = {
      from: () => {
        throw new Error('network down')
      },
    }

    const removed = await removeInvoicePaymentRow(
      supabase as unknown as SupabaseClient,
      'company-1',
      'ip-1',
    )

    expect(removed).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('rollback threw'),
      expect.any(Error),
      { companyId: 'company-1', invoicePaymentId: 'ip-1' },
    )
  })
})
