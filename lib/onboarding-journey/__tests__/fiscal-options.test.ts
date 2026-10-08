import { describe, it, expect } from 'vitest'
import { efFirstYearEndOptions } from '../fiscal-options'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'

/**
 * BFL 3 kap sets no minimum length for a first räkenskapsår, only the
 * 18-month maximum. PR #1165 removed an invented 6-month floor from
 * validatePeriodDuration; these tests pin the same rule on the onboarding
 * journey's option generator, which kept the floor until now.
 */

/** The journey's own gate before submit: option -> computeFiscalPeriod. */
function journeyAccepts(start: string, end: string): string | null {
  return computeFiscalPeriod({
    entity_type: 'enskild_firma',
    is_first_fiscal_year: true,
    first_year_start: start,
    first_year_end: end,
  }).error
}

describe('efFirstYearEndOptions', () => {
  it('offers the short first year an autumn registration needs', () => {
    const options = efFirstYearEndOptions(2026, 10)
    expect(options.map((o) => o.months)).toEqual([3, 15])
    for (const o of options) expect(journeyAccepts('2026-10-01', o.date)).toBeNull()
  })
})
