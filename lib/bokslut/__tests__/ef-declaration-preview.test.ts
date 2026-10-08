import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeEfDeclarationPreview } from '../enskild-firma/ef-declaration-preview'

// the real NE engine runs on a mocked trial balance, so the preview base is
// whatever NE R11 says for these rows
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'

const PERIOD = { id: 'fp-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }

type Row = { account_number: string; account_name: string; closing_debit: number; closing_credit: number }

function row(account_number: string, side: 'debit' | 'credit', amount: number): Row {
  return {
    account_number,
    account_name: `Konto ${account_number}`,
    closing_debit: side === 'debit' ? amount : 0,
    closing_credit: side === 'credit' ? amount : 0,
  }
}

function useRows(rowsFor: (closingEntry: string | undefined) => Row[]) {
  vi.mocked(generateTrialBalance).mockImplementation((async (
    _supabase: unknown,
    _companyId: unknown,
    _periodId: unknown,
    options?: { closingEntry?: string },
  ) => ({ rows: rowsFor(options?.closingEntry) })) as never)
}

/** Table-routed mock: the fiscal period row and the company_settings row the NE engine reads. */
function makeSupabase() {
  const rows: Record<string, unknown> = {
    fiscal_periods: { ...PERIOD, is_closed: false },
    company_settings: { entity_type: 'enskild_firma' },
  }
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq']) chain[name] = () => chain
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    chain.maybeSingle = chain.single
    return chain
  })
  return { from } as unknown as SupabaseClient
}

describe('computeEfDeclarationPreview: base is NE R11', () => {
  // Sale 200 000, rent 50 000 and a year-end depreciation entry of 20 000
  // (source_type 'year_end'). The income statement reads the books with
  // 'exclude-all-year-end' and would leave the depreciation out (150 000);
  // NE R11 keeps every bokslut entry but the final closing entry (130 000).
  beforeEach(() => {
    vi.clearAllMocks()
    useRows((closingEntry) => [
      row('3001', 'credit', 200_000),
      row('5010', 'debit', 50_000),
      ...(closingEntry === 'exclude-all-year-end' ? [] : [row('7832', 'debit', 20_000)]),
    ])
  })

  it('takes the booked surplus from NE R11, year-end depreciation included', async () => {
    const supabase = makeSupabase()

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')
    const ne = await generateNEDeclaration(supabase, 'co-1', 'fp-1')

    expect(preview.fiscalPeriod).toMatchObject(PERIOD)
    expect(ne.rutor.R11).toBe(130_000)
    expect(preview.bookedSurplus).toBe(ne.rutor.R11)
    for (const call of vi.mocked(generateTrialBalance).mock.calls) {
      expect(call[3]).toMatchObject({ closingEntry: 'exclude-final' })
    }
  })

  it('computes egenavgifter on that base', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1')
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 130_000 })
    expect(egenavgifter?.amount).toBe(32_500)
  })

  it('rounds the base to whole kronor like the NE-bilaga', async () => {
    useRows(() => [row('3001', 'credit', 100_000.4), row('5010', 'debit', 20_000.3)])

    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1')

    expect(preview.bookedSurplus).toBe(80_000)
  })
})
