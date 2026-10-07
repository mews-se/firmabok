import { describe, it, expect } from 'vitest'
import { formatCurrency } from '../utils'

describe('formatCurrency', () => {
  it('falls back to SEK for a NULL currency instead of throwing', () => {
    // transactions.currency is nullable and NULL is legacy for the 'SEK'
    // column default (migration 20260726100000), but the Transaction type
    // declares it required. Intl throws RangeError on `currency: null`, and
    // one such row used to blank the whole transactions list.
    expect(() => formatCurrency(1234.5, null)).not.toThrow()
    expect(formatCurrency(1234.5, null)).toBe(formatCurrency(1234.5, 'SEK'))
  })

  it('falls back to SEK for undefined and for an empty string', () => {
    expect(formatCurrency(10, undefined)).toBe(formatCurrency(10, 'SEK'))
    expect(formatCurrency(10, '')).toBe(formatCurrency(10, 'SEK'))
    expect(formatCurrency(10)).toBe(formatCurrency(10, 'SEK'))
  })

  it('still honours a real currency code', () => {
    expect(formatCurrency(10, 'EUR')).toContain('€')
  })
})
