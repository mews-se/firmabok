import { describe, it, expect } from 'vitest'
import {
  validatePersonnummer,
  extractLast4,
  extractBirthDate,
  calculateAge,
  calculateAgeAtYearStart,
  maskPersonnummer,
  formatPersonnummer,
  encryptPersonnummer,
  decryptPersonnummer,
} from '../personnummer'

describe('validatePersonnummer', () => {
  it('accepts valid 12-digit personnummer', () => {
    // Valid test personnummer (checksum matches)
    const result = validatePersonnummer('199001019802')
    expect(result.valid).toBe(true)
  })

  it('rejects non-12-digit input', () => {
    const result = validatePersonnummer('9001019802')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('12 siffror')
  })

  it('rejects invalid month', () => {
    const result = validatePersonnummer('199013019802')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('månad')
  })

  it('rejects invalid day', () => {
    // Luhn-valid on purpose, so this proves the day check is what rejects it
    // rather than the checksum incidentally failing first.
    const result = validatePersonnummer('199001329805')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('dag')
  })

  it('strips non-digits before validation', () => {
    const result = validatePersonnummer('19900101-9802')
    expect(result.valid).toBe(true)
  })

  // A samordningsnummer is a personnummer whose day field carries an added 60,
  // so the printed day is 61-91. Skatteverket files these under FK215 in the
  // arbetsgivardeklaration exactly like a personnummer, and our AGI generator
  // accepts them, so the employee validator has to accept them too. All values
  // below are synthetic and genuinely check-digit valid.
  describe('samordningsnummer', () => {
    it('accepts day 61 (the 1st, offset by 60)', () => {
      expect(validatePersonnummer('199001619809').valid).toBe(true)
    })

    it('accepts day 91 (the 31st, offset by 60)', () => {
      expect(validatePersonnummer('199001919803').valid).toBe(true)
    })

    it('still enforces the Luhn checksum on the offset form', () => {
      // Same samordningsnummer as above with the check digit bumped: the +60
      // offset must not become a way to skip the checksum.
      const result = validatePersonnummer('199001619808')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Luhn')
    })

    it('rejects days 32-60, which are neither a day nor an offset day', () => {
      // Both Luhn-valid, so only the day range can be rejecting them.
      expect(validatePersonnummer('199001329805').valid).toBe(false)
      expect(validatePersonnummer('199001609800').valid).toBe(false)
    })

    it('rejects days 92-99, which offset back to day 32-39', () => {
      expect(validatePersonnummer('199001929802').valid).toBe(false)
      expect(validatePersonnummer('199001999805').valid).toBe(false)
    })
  })
})

describe('extractLast4', () => {
  it('extracts last 4 digits', () => {
    expect(extractLast4('199001019802')).toBe('9802')
  })

  it('handles dash-formatted input', () => {
    expect(extractLast4('19900101-9802')).toBe('9802')
  })
})

describe('extractBirthDate', () => {
  it('extracts birth date from 12-digit personnummer', () => {
    const result = extractBirthDate('199001019802')
    expect(result.year).toBe(1990)
    expect(result.month).toBe(1)
    expect(result.day).toBe(1)
  })

  it('normalizes the samordningsnummer day offset to the real calendar day', () => {
    // Day 61 = the 1st + 60, day 91 = the 31st + 60. The offset is a numbering
    // convention on the printed digits, not a calendar fact: consumers doing
    // date math must see 1-31, never 61-91. Same synthetic, Luhn-valid
    // samordningsnummer as the validatePersonnummer suite above.
    expect(extractBirthDate('199001619809')).toEqual({ year: 1990, month: 1, day: 1 })
    expect(extractBirthDate('199001919803')).toEqual({ year: 1990, month: 1, day: 31 })
  })

  it('leaves ordinary days 1-31 untouched', () => {
    expect(extractBirthDate('199006159802').day).toBe(15)
  })
})

describe('calculateAge', () => {
  it('calculates age at a given date', () => {
    expect(calculateAge('199001019802', '2026-04-14')).toBe(36)
  })

  it('returns age minus one before birthday', () => {
    expect(calculateAge('199006159802', '2026-06-14')).toBe(35)
    expect(calculateAge('199006159802', '2026-06-15')).toBe(36)
  })

  it('computes samordningsnummer age from the real calendar day', () => {
    // 199001619809 is born 1990-01-01 (printed day 61 = 1 + 60). Comparing the
    // reference day against the OFFSET day made `refDay < birth.day` true for
    // every day of the birth month, shaving a year off the age until the month
    // was over: born-on-the-1st read as 35 on their own 36th birthday.
    expect(calculateAge('199001619809', '2026-01-01')).toBe(36)
    expect(calculateAge('199001619809', '2025-12-31')).toBe(35)
    // End of the offset range too: 1990-01-31 (printed day 91).
    expect(calculateAge('199001919803', '2026-01-30')).toBe(35)
    expect(calculateAge('199001919803', '2026-01-31')).toBe(36)
  })
})

describe('calculateAgeAtYearStart', () => {
  // Skatteverket applies "vid årets ingång fyllt X" rules as birth-year
  // ranges, so the age is the one attained by December 31 of the prior year.
  it('is birth-year based: same birth year means same year-start age', () => {
    expect(calculateAgeAtYearStart('199006159802', 2026)).toBe(35)
    expect(calculateAgeAtYearStart('199012319802', 2026)).toBe(35)
  })

  it('does not count a January 1 birthday as attained at årets ingång', () => {
    // The 2026 youth cohort is born 2003-2007: born 2003-01-01 must read
    // as 22 (eligible) and born 2008-01-01 as 17 (not eligible).
    expect(calculateAgeAtYearStart('199001019802', 2026)).toBe(35)
    expect(calculateAgeAtYearStart('200301011234', 2026)).toBe(22)
    expect(calculateAgeAtYearStart('200801011234', 2026)).toBe(17)
  })
})

describe('maskPersonnummer', () => {
  it('shows birthdate and masks the 4-digit suffix', () => {
    expect(maskPersonnummer('199001019802')).toBe('19900101-XXXX')
  })

  it('strips non-digits before masking', () => {
    expect(maskPersonnummer('19900101-9802')).toBe('19900101-XXXX')
  })
})

describe('formatPersonnummer', () => {
  it('formats with dash', () => {
    expect(formatPersonnummer('199001019802')).toBe('19900101-9802')
  })
})

describe('encryption roundtrip', () => {
  it('encrypts and decrypts correctly', () => {
    const pnr = '199001019802'
    const encrypted = encryptPersonnummer(pnr)
    expect(encrypted).not.toBe(pnr)
    expect(encrypted.length).toBeGreaterThan(pnr.length)

    const decrypted = decryptPersonnummer(encrypted)
    expect(decrypted).toBe(pnr)
  })

  it('produces different ciphertexts for same input (random IV)', () => {
    const pnr = '199001019802'
    const a = encryptPersonnummer(pnr)
    const b = encryptPersonnummer(pnr)
    expect(a).not.toBe(b)
  })
})

describe('decryptPersonnummer tolerance for unencrypted rows', () => {
  it('passes a raw 12-digit personnummer through unchanged (no crash)', () => {
    // A row stored unencrypted (pre-fix v1 create, or a seed) would otherwise
    // be sliced as iv/ciphertext/tag and throw ERR_CRYPTO_INVALID_AUTH_TAG
    // ("Invalid authentication tag length: 6"), 500-ing the whole roster.
    expect(decryptPersonnummer('190001010000')).toBe('190001010000')
  })

  it('still decrypts genuine ciphertext', () => {
    const enc = encryptPersonnummer('199001019802')
    expect(decryptPersonnummer(enc)).toBe('199001019802')
  })
})
