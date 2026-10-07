import { describe, it, expect } from 'vitest'
import { levenshteinDistance, normalizeMerchantName } from '../merchant-name'

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0)
  })

  it('returns length of other string for empty string', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3)
    expect(levenshteinDistance('abc', '')).toBe(3)
  })

  it('calculates correct edit distance', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3)
  })
})

describe('normalizeMerchantName', () => {
  it('lowercases and trims', () => {
    expect(normalizeMerchantName('  ICA MAXI  ')).toBe('ica maxi')
  })

  it('removes Swedish company suffixes', () => {
    expect(normalizeMerchantName('Telia AB')).toBe('telia')
  })

  it('removes special characters but keeps Swedish letters', () => {
    expect(normalizeMerchantName('Café Överkås!')).toBe('café överkås')
  })

  it('collapses whitespace', () => {
    expect(normalizeMerchantName('ica   maxi   stockholm')).toBe('ica maxi stockholm')
  })
})
