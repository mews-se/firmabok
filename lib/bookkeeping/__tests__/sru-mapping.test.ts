import { describe, it, expect } from 'vitest'
import { computeSRUCode } from '../bas-data/sru-mapping'
import { BAS_REFERENCE } from '../bas-data'
import { findNEMapping } from '@/lib/reports/ne-bilaga/ne-engine'

// NE-bilaga field codes, Skatteverket NE_SKV2161 (2026P4)
const NE_FIELD_CODES: Record<string, string> = {
  B1: '7200', B2: '7210', B3: '7211', B4: '7212', B5: '7213', B6: '7240', B7: '7250', B8: '7260',
  B9: '7280', B10: '7300', B11: '7320', B12: '7330', B13: '7380', B14: '7381', B15: '7382', B16: '7383',
  R1: '7400', R2: '7401', R3: '7402', R4: '7403', R5: '7500', R6: '7501', R7: '7502', R8: '7503',
  R9: '7504', R10: '7505', R11: '7440',
}

describe('computeSRUCode', () => {
  it.each([
    ['1010', 'B1'],
    ['1110', 'B2'],
    ['1130', 'B3'],
    ['1291', 'B3'],
    ['1220', 'B4'],
    ['1350', 'B5'],
    ['1460', 'B6'],
    ['1510', 'B7'],
    ['1630', 'B8'],
    ['1930', 'B9'],
    ['2010', 'B10'],
    ['2013', 'B10'],
    ['2018', 'B10'],
    ['2110', 'B11'],
    ['2220', 'B12'],
    ['2350', 'B13'],
    ['2440', 'B15'],
    ['2611', 'B16'],
    ['2890', 'B16'],
    ['3001', 'R1'],
    ['3740', 'R1'],
    ['3100', 'R2'],
    ['3960', 'R2'],
    ['4010', 'R5'],
    ['5010', 'R6'],
    ['6992', 'R6'],
    ['7010', 'R7'],
    ['7960', 'R8'],
    ['8410', 'R8'],
    ['8423', 'R8'],
    ['7820', 'R9'],
    ['7832', 'R10'],
    ['8850', 'R10'],
    ['8314', 'R4'],
    ['8999', 'R11'],
  ])('maps %s to %s', (account, row) => {
    expect(computeSRUCode(account)).toBe(NE_FIELD_CODES[row])
  })

  it('picks R4 or R8 by normal balance in the groups BAS marks (+) and (-)', () => {
    expect(computeSRUCode('8811', 'debit')).toBe('7503')
    expect(computeSRUCode('8819', 'credit')).toBe('7403')
    expect(computeSRUCode('8430', 'debit')).toBe('7503')
    expect(computeSRUCode('8330', 'credit')).toBe('7403')
  })

  it('gives no code to accounts outside every NE field', () => {
    for (const account of ['2081', '2091', '2099', '2510', '8830', '9999']) {
      expect(computeSRUCode(account), account).toBeNull()
    }
  })
})

describe('BAS reference SRU codes', () => {
  it('are NE field codes', () => {
    const fieldCodes = new Set(Object.values(NE_FIELD_CODES))
    const other = BAS_REFERENCE.filter((a) => a.sru_code !== null && !fieldCodes.has(a.sru_code))
    expect(other.map((a) => `${a.account_number} ${a.sru_code}`)).toEqual([])
  })

  it('put every result account on the row the NE engine sums it into', () => {
    const mismatches = BAS_REFERENCE.filter((a) => a.account_class >= 3).flatMap((a) => {
      const ruta = findNEMapping(a.account_number, a.normal_balance === 'credit' ? -1 : 1)?.ruta
      const expected = ruta ? NE_FIELD_CODES[ruta] : a.account_number.startsWith('899') ? '7440' : null
      return a.sru_code === expected ? [] : [`${a.account_number}: ${a.sru_code}, NE engine ${expected}`]
    })
    expect(mismatches).toEqual([])
  })
})
