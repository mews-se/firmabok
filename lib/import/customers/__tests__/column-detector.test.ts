import { describe, it, expect } from 'vitest'
import { detectCustomerColumns } from '../column-detector'

describe('detectCustomerColumns', () => {
  it('detects Swedish customer register headers', () => {
    const headers = ['Namn', 'Orgnr', 'E-post', 'Telefon', 'Adress', 'Postnr', 'Ort']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.email_col).toBe(2)
    expect(result.phone_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('detects English headers', () => {
    const headers = ['Customer Name', 'Organization Number', 'Email', 'Phone']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.email_col).toBe(2)
    expect(result.phone_col).toBe(3)
  })

  it('handles missing optional columns', () => {
    const headers = ['Kundnamn']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.email_col).toBeNull()
    expect(result.org_number_col).toBeNull()
  })

  it('does not match the same column twice', () => {
    const headers = ['Namn', 'Adress', 'C/O']
    const result = detectCustomerColumns(headers)
    expect(result.address_line1_col).toBe(1)
    expect(result.address_line2_col).toBe(2)
  })

  it('returns low confidence when name not matched', () => {
    const headers = ['ColA', 'ColB']
    const result = detectCustomerColumns(headers)
    expect(result.confidence).toBe(0)
  })
})
