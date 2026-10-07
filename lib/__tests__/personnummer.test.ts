import { describe, it, expect } from 'vitest'
import {
  validatePersonnummer,
  extractLast4,
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
