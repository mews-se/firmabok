import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildDispositionsProposal } from '../dispositions-proposal-builder'

const period = {
  id: 'period-1',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateIncomeStatement).mockResolvedValue({
    net_result: 123_456.78,
  } as Awaited<ReturnType<typeof generateIncomeStatement>>)
})

describe('buildDispositionsProposal', () => {
  it('returns the booked result and the entity type for an enskild firma', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: period })
    enqueue({ data: { entity_type: 'enskild_firma' } })

    const result = await buildDispositionsProposal(supabase as never, 'company-1', 'period-1')

    expect(result).toEqual({
      entityType: 'enskild_firma',
      fiscalPeriod: period,
      netResultBefore: 123_456.78,
    })
    expect(generateIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'period-1')
  })

  it('throws when the period does not belong to the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      buildDispositionsProposal(supabase as never, 'company-1', 'period-1'),
    ).rejects.toThrow('Fiscal period not found')
    expect(generateIncomeStatement).not.toHaveBeenCalled()
  })
})
