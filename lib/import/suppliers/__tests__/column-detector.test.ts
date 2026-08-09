import { describe, it, expect } from 'vitest'
import { detectSupplierColumns } from '../column-detector'

describe('detectSupplierColumns', () => {
  it('detects Swedish supplier register headers', () => {
    const headers = ['Namn', 'Orgnr', 'Bankgiro', 'Plusgiro', 'IBAN', 'BIC', 'E-post']
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
    expect(result.plusgiro_col).toBe(3)
    expect(result.iban_col).toBe(4)
    expect(result.bic_col).toBe(5)
    expect(result.email_col).toBe(6)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('handles supplier-specific keyword "Leverantör"', () => {
    const headers = ['Leverantör', 'Orgnummer', 'Bankgiro']
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
  })

  it('does not confuse plusgiro with bankgiro', () => {
    const headers = ['Namn', 'Plusgiro', 'Bankgiro']
    const result = detectSupplierColumns(headers)
    expect(result.plusgiro_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
  })

  it('returns confidence 0 with no name column', () => {
    const headers = ['ColA', 'ColB']
    const result = detectSupplierColumns(headers)
    expect(result.confidence).toBe(0)
  })
})
