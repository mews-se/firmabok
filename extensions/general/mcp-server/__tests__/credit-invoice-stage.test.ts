import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_credit_invoice')!

function original(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: '001',
    document_type: 'invoice',
    status: 'sent',
    total: 12500,
    currency: 'SEK',
    journal_entry_id: null,
    paid_at: null,
    paid_amount: 0,
    customer: { name: 'Kund AB' },
    ...overrides,
  }
}

type Staged = { staged: boolean; preview: Record<string, unknown>; next?: { description?: string } }

async function stage(invoiceRow: Record<string, unknown>, accountingMethod: string): Promise<Staged> {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: invoiceRow })
  enqueue({ data: { accounting_method: accountingMethod } })
  enqueue({ data: { id: 'op-credit-1' } })

  return (await tool().execute(
    { invoice_id: INVOICE_ID },
    'company-1',
    'user-1',
    supabase as never,
  )) as Staged
}

describe('gnubok_credit_invoice staging preview', () => {
  it('no longer promises the reversal under faktureringsmetoden only', () => {
    expect(tool().description).not.toMatch(/\(accrual\)/)
    expect(tool().description).toMatch(/kontantmetoden/)
  })

  it('says a verifikat posts for a paid kontantmetod original', async () => {
    const result = await stage(
      original({ status: 'paid', paid_at: '2027-03-20T00:00:00Z', paid_amount: 12500 }),
      'cash',
    )

    expect(result.staged).toBe(true)
    expect(result.preview.posts_journal_entry).toBe(true)
    expect(String(result.preview.method)).toMatch(/1510/)
  })

  it('says no verifikat for an unpaid, never-booked kontantmetod original', async () => {
    const result = await stage(original(), 'cash')

    expect(result.staged).toBe(true)
    expect(result.preview.posts_journal_entry).toBe(false)
    expect(String(result.next?.description)).toMatch(/nothing to reverse/)
  })

  it('always posts under faktureringsmetoden', async () => {
    const result = await stage(original(), 'accrual')

    expect(result.preview.posts_journal_entry).toBe(true)
  })
})
