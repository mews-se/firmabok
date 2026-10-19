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
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1', {
      pfondDesiredAmount: 0,
    })
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

describe('computeEfDeclarationPreview: R13 and R14 adjust the base', () => {
  // Representation on 6072 and skattekonto interest on 8423 stay in R6 and R8
  // but go back in R13; the skattekonto interest income on 8314 stays in R4
  // and comes out in R14. R11 145 850 + R13 4 300 - R14 150 = 150 000.
  beforeEach(() => {
    vi.clearAllMocks()
    useRows(() => [
      row('3001', 'credit', 200_000),
      row('5010', 'debit', 50_000),
      row('6072', 'debit', 4_000),
      row('8423', 'debit', 300),
      row('8314', 'credit', 150),
    ])
  })

  it('reports the booked result and the adjusted base apart', async () => {
    const supabase = makeSupabase()

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')
    const ne = await generateNEDeclaration(supabase, 'co-1', 'fp-1')

    expect(ne.rutor).toMatchObject({ R11: 145_850, R12: 145_850, R13: 4_300, R14: 150 })
    expect(preview.bookedSurplus).toBe(145_850)
    expect(preview.surplusBeforeRantefordelning).toBe(150_000)
  })

  it('computes egenavgifter on the adjusted base', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1', {
      pfondDesiredAmount: 0,
    })
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 150_000 })
    expect(egenavgifter?.amount).toBe(37_500)
  })

  it('caps the periodiseringsfond on the adjusted base', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1')
    const pfond = preview.items.find((i) => i.kind === 'periodiseringsfond_avsattning')

    expect(pfond?.computation).toMatchObject({ surplus: 150_000, maxAmount: 45_000 })
  })

  it('leaves the base at R11 when nothing goes in R13 or R14', async () => {
    useRows(() => [row('3001', 'credit', 200_000), row('6071', 'debit', 4_000)])

    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1')

    expect(preview.bookedSurplus).toBe(196_000)
    expect(preview.surplusBeforeRantefordelning).toBe(196_000)
  })
})

describe('computeEfDeclarationPreview: NE order of the adjustments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRows(() => [row('3001', 'credit', 200_000), row('5010', 'debit', 50_000)])
  })

  it('caps the periodiseringsfond before the schablonavdrag and takes it off R42', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1')
    const pfond = preview.items.find((i) => i.kind === 'periodiseringsfond_avsattning')
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(pfond?.computation).toMatchObject({ surplus: 150_000, maxAmount: 45_000 })
    expect(pfond?.amount).toBe(45_000)
    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 105_000 })
    expect(egenavgifter?.amount).toBe(26_250)
  })

  it('adds negative räntefördelning before the periodiseringsfond cap', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1', {
      kapitalunderlag: -600_000,
    })
    const r = preview.items.find((i) => i.kind === 'rantefordelning_negative')
    const pfond = preview.items.find((i) => i.kind === 'periodiseringsfond_avsattning')
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(r?.amount).toBe(21_300)
    expect(pfond?.computation).toMatchObject({ surplus: 171_300, maxAmount: 51_390 })
    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 119_910 })
  })

  it('adds an expansionsfond återföring to the schablonavdrag base', async () => {
    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1', {
      pfondDesiredAmount: 0,
      expansionsfondExistingBalance: 30_000,
      expansionsfondDesiredChange: -10_000,
    })
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(preview.items.map((i) => i.kind)).toEqual(['egenavgifter', 'expansionsfond_ateforing'])
    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 160_000 })
    expect(egenavgifter?.amount).toBe(40_000)
  })

  it("matches Skatteverket's worked NE example up to R42", async () => {
    // "Fylla i NE-bilagan, exempel": R13 1 250, R30 25 000, R34 10 000,
    // R36 100 000, R40 98 527 and R41 81 768 give R35 239 400 and R42 156 159
    useRows(() => [
      row('3001', 'credit', 400_000),
      row('5010', 'debit', 125_600),
      row('6072', 'debit', 1_250),
    ])

    const preview = await computeEfDeclarationPreview(makeSupabase(), 'co-1', 'fp-1', {
      kapitalunderlag: 292_398,
      pfondDesiredAmount: 10_000,
      expansionsfondDesiredChange: 100_000,
      priorYearSchablonavdrag: 98_527,
      priorYearActualCharged: 81_768,
    })
    const byKind = Object.fromEntries(preview.items.map((i) => [i.kind, i]))

    expect(preview.items.map((i) => i.kind)).toEqual([
      'egenavgifter',
      'rantefordelning_positive',
      'periodiseringsfond_avsattning',
      'expansionsfond_avsattning',
    ])
    expect(preview.surplusBeforeRantefordelning).toBe(274_400)
    expect(byKind.rantefordelning_positive.amount).toBe(25_000)
    expect(byKind.periodiseringsfond_avsattning.computation).toMatchObject({ surplus: 249_400 })
    expect(byKind.periodiseringsfond_avsattning.amount).toBe(10_000)
    expect(byKind.expansionsfond_avsattning.amount).toBe(100_000)
    expect(byKind.egenavgifter.computation).toMatchObject({
      surplusBeforeEgenavgifter: 139_400,
      netSurplusForSchablon: 156_159,
    })
  })
})
