import { describe, it, expect } from 'vitest'
import { PASSWORD_MIN_LENGTH, isValidPassword } from '../password-policy'

describe('isValidPassword', () => {
  it('accepts a password exactly at the minimum length', () => {
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true)
  })

  it('rejects one character below the minimum', () => {
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(isValidPassword('')).toBe(false)
  })

  it('no longer demands mixed case, digits or special characters', () => {
    expect(isValidPassword('aaaaaa')).toBe(true)
    expect(isValidPassword('123456')).toBe(true)
    expect(isValidPassword('......')).toBe(true)
  })

  it('never drops below GoTrue\'s own floor, which would let the form accept what auth rejects', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(6)
  })
})

