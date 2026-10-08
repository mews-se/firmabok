import { describe, it, expect } from 'vitest'
import { formatAmount } from '@/lib/reports/ne-bilaga/sru-generator'
import { calculateEgenavgifter } from '@/lib/bokslut/enskild-firma/egenavgifter-calculator'

/**
 * One bug class in one file: a whole-krona floor or truncation applied to a
 * sum of doubles that landed just under an integer. The inputs are ordinary
 * two-decimal amounts, not hand-picked edge cases.
 */
describe('whole-krona rounding survives double drift', () => {
  it.each([
    { sum: 1.57 + 0.43, expected: '2' },
    { sum: 1033.54 + 1203.03 + 259.43, expected: '2496' },
    { sum: 1668.37 + 210.04 + 132.59, expected: '2011' },
    { sum: 1686 + 1275.82 + 688.18, expected: '3650' },
  ])('formats the drifting NE SRU sum as $expected kronor', ({ sum, expected }) => {
    expect(formatAmount(sum)).toBe(expected)
    expect(formatAmount(-sum)).toBe(`-${expected}`)
  })

  it.each([
    { amount: 0, expected: '0' },
    { amount: -0, expected: '0' },
    { amount: 2496, expected: '2496' },
    { amount: -2496, expected: '-2496' },
    { amount: 2495.99, expected: '2495' },
    { amount: -2495.99, expected: '-2495' },
    { amount: 0.99, expected: '0' },
    { amount: -0.99, expected: '0' },
  ])('drops genuine öre from $amount and normalizes zero', ({ amount, expected }) => {
    expect(formatAmount(amount)).toBe(expected)
  })

  it.each([
    { surplus: 10209.31, priorSchablon: 1854.55, priorActual: 43.86, net: 12020, expected: 3005 },
    { surplus: 4721.11, priorSchablon: 1915.69, priorActual: 1804.80, net: 4832, expected: 1208 },
    { surplus: 3507.45, priorSchablon: 466.53, priorActual: 421.98, net: 3552, expected: 888 },
  ])('keeps R43 at $expected for net surplus $net', ({ surplus, priorSchablon, priorActual, net, expected }) => {
    const result = calculateEgenavgifter({
      surplusBeforeEgenavgifter: surplus,
      priorYearSchablonavdrag: priorSchablon,
      priorYearActualCharged: priorActual,
    })
    expect(result.ne_ruta).toBe('R43')
    expect(result.amount).toBe(expected)
    expect(result.computation).toMatchObject({ netSurplusForSchablon: net, schablonavdrag: expected })
  })

  it.each([
    { category: 'pensioner' as const, expected: 1202 },
    { category: 'passive' as const, expected: 2404 },
  ])('keeps the $category schablonavdrag at $expected', ({ category, expected }) => {
    const result = calculateEgenavgifter({
      surplusBeforeEgenavgifter: 10209.31,
      priorYearSchablonavdrag: 1854.55,
      priorYearActualCharged: 43.86,
      category,
    })
    expect(result.amount).toBe(expected)
  })

  it.each([
    { surplus: 12020, expected: 3005 },
    { surplus: 12019.99, expected: 3004 },
    { surplus: 0, expected: 0 },
    { surplus: -12020, expected: 0 },
  ])('preserves the deduction for surplus $surplus', ({ surplus, expected }) => {
    expect(calculateEgenavgifter({ surplusBeforeEgenavgifter: surplus }).amount).toBe(expected)
  })
})
