import { describe, it, expect } from 'vitest'
import { amountsMatchExact, amountsMatchFuzzy, customerNameMatches } from '../invoice-matching'

// ============================================================
// amountsMatchExact
// ============================================================

describe('amountsMatchExact', () => {
  it('matches identical amounts', () => {
    expect(amountsMatchExact(1000, 1000)).toBe(true)
  })

  it('matches amounts differing only in floating-point noise', () => {
    // 1000.004 rounds to 1000.00, same as 1000.00
    expect(amountsMatchExact(1000.004, 1000)).toBe(true)
  })

  it('rejects amounts differing by 0.01', () => {
    expect(amountsMatchExact(1000.01, 1000)).toBe(false)
  })
})

// ============================================================
// amountsMatchFuzzy
// ============================================================

describe('amountsMatchFuzzy', () => {
  it('matches amounts within 1% tolerance', () => {
    // 990 vs 1000 → diff=10, tolerance=min(10,500)=10 → 10 <= 10
    expect(amountsMatchFuzzy(990, 1000)).toBe(true)
  })

  it('rejects amounts outside 1% tolerance', () => {
    // 980 vs 1000 → diff=20, tolerance=min(10,500)=10 → 20 > 10
    expect(amountsMatchFuzzy(980, 1000)).toBe(false)
  })

  it('returns false when invoiceTotal is 0', () => {
    expect(amountsMatchFuzzy(100, 0)).toBe(false)
  })

  it('caps tolerance at 500 SEK for large invoices', () => {
    // 100000 vs 100600 → diff=600, tolerance=min(100000*0.01=1000, 500)=500 → 600 > 500
    expect(amountsMatchFuzzy(100600, 100000)).toBe(false)
    // 100000 vs 100400 → diff=400, tolerance=500 → 400 <= 500
    expect(amountsMatchFuzzy(100400, 100000)).toBe(true)
  })
})

// ============================================================
// customerNameMatches
// ============================================================

describe('customerNameMatches', () => {
  it('matches when significant word from customer name appears in description', () => {
    expect(customerNameMatches('Kontorsbolaget AB', 'Betalning Kontorsbolaget', null)).toBe(true)
  })

  it('ignores words shorter than 3 characters', () => {
    // "AB" is 2 chars, filtered out
    expect(customerNameMatches('AB', 'AB payment', null)).toBe(false)
  })

  it('matches against the counterparty', () => {
    expect(customerNameMatches('Kontorsbolaget', 'Random description', 'Kontorsbolaget AB')).toBe(true)
  })

  it('returns false when customerName is undefined', () => {
    expect(customerNameMatches(undefined as unknown as string, 'Description', null)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(customerNameMatches('KONTORSBOLAGET', 'betalning kontorsbolaget', null)).toBe(true)
  })
})
