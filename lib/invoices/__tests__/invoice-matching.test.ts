import { describe, it, expect } from 'vitest'
import {
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
  descriptionMentionsReference,
} from '../invoice-matching'

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

// ============================================================
// descriptionMentionsReference
// ============================================================

describe('descriptionMentionsReference', () => {
  it('never matches a single digit: "1" is in almost every text', () => {
    expect(descriptionMentionsReference('Betalning faktura 1', '1')).toBe(false)
    expect(descriptionMentionsReference('Betalning faktura 10', '1')).toBe(false)
    expect(descriptionMentionsReference('Betalning faktura 21', '1')).toBe(false)
  })

  it('matches a number only where it stands alone', () => {
    expect(descriptionMentionsReference('Betalning faktura 12, Kund AB', '12')).toBe(true)
    expect(descriptionMentionsReference('Betalning faktura 112', '12')).toBe(false)
    expect(descriptionMentionsReference('Betalning faktura 123', '12')).toBe(false)
    expect(descriptionMentionsReference('Inbetalning 2012-05-01', '12')).toBe(false)
    expect(descriptionMentionsReference('Levbet Tele2 Sverige AB (1814)', 14)).toBe(false)
  })

  it('keeps padded invoice numbers apart', () => {
    expect(descriptionMentionsReference('Kontantbetalning kundfaktura 001, Kund AB', '001')).toBe(true)
    expect(descriptionMentionsReference('Betalning faktura 1001', '001')).toBe(false)
  })

  it('matches a number followed by a date', () => {
    expect(descriptionMentionsReference('Faktura 001 2027-03-20', '001')).toBe(true)
  })

  it('matches an OCR number typed in groups against the digits run together', () => {
    expect(descriptionMentionsReference('OCR 12345678', '1234 5678')).toBe(true)
  })

  it('handles a missing text or reference', () => {
    expect(descriptionMentionsReference(null, '12')).toBe(false)
    expect(descriptionMentionsReference('Faktura 12', null)).toBe(false)
    expect(descriptionMentionsReference('Faktura 12', undefined)).toBe(false)
  })
})
