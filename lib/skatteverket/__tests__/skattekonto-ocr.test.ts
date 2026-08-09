import { describe, it, expect } from 'vitest'
import { generateSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '../skattekonto-ocr'
import { luhnValidate } from '@/lib/bankgiro/luhn'

describe('generateSkattekontoOcr', () => {
  it('produces 11-digit OCR with valid Luhn check digit for AB org-number', () => {
    const ocr = generateSkattekontoOcr('556012-3456')
    expect(ocr).toHaveLength(11)
    expect(ocr.startsWith('5560123456')).toBe(true)
    expect(luhnValidate(ocr)).toBe(true)
  })

  it('accepts org-number without dash', () => {
    expect(generateSkattekontoOcr('5560123456')).toBe(generateSkattekontoOcr('556012-3456'))
  })

  it('accepts 12-digit personnummer by stripping century prefix', () => {
    const ocr12 = generateSkattekontoOcr('198802251234')
    const ocr10 = generateSkattekontoOcr('880225-1234')
    expect(ocr12).toBe(ocr10)
  })

  it('rejects malformed numbers', () => {
    expect(() => generateSkattekontoOcr('123')).toThrow(/Ogiltigt/)
    expect(() => generateSkattekontoOcr('')).toThrow(/Ogiltigt/)
    expect(() => generateSkattekontoOcr('abcdefghij')).toThrow(/Ogiltigt/)
  })

  it('exports correct Bankgiro for Skattekontot', () => {
    expect(SKATTEKONTO_BANKGIRO).toBe('5050-1055')
  })
})
