import { describe, it, expect } from 'vitest'
import { findNEMapping } from '../ne-engine'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

/**
 * The ruta an account lands in for a debit (kostnad) or credit (intäkt) balance
 */
function findRutaForAccount(accountNumber: string, side: 'debit' | 'credit' = 'credit'): string | null {
  return findNEMapping(accountNumber, side === 'credit' ? -1 : 1)?.ruta ?? null
}

describe('NE Account Mappings', () => {
  describe('R1 - Momspliktiga intäkter', () => {
    it('includes standard revenue accounts 3001-3003', () => {
      expect(findRutaForAccount('3001')).toBe('R1')
      expect(findRutaForAccount('3002')).toBe('R1')
      expect(findRutaForAccount('3003')).toBe('R1')
    })

    it('excludes 3100 (momsfria intäkter)', () => {
      expect(findRutaForAccount('3100')).not.toBe('R1')
    })

    it('includes 3200 (Försäljning VMB och omvänd moms)', () => {
      expect(findRutaForAccount('3200')).toBe('R1')
      expect(findRutaForAccount('3231')).toBe('R1')
    })

    it('includes 3500 (Fakturerade kostnader)', () => {
      expect(findRutaForAccount('3500')).toBe('R1')
    })

    it('includes 3500-3599 range', () => {
      expect(findRutaForAccount('3510')).toBe('R1')
      expect(findRutaForAccount('3599')).toBe('R1')
    })

    it('includes 3600-3699 (Rörelsens sidointäkter)', () => {
      expect(findRutaForAccount('3600')).toBe('R1')
      expect(findRutaForAccount('3690')).toBe('R1')
    })

    it('includes 3700-3799 (Lämnade rabatter)', () => {
      expect(findRutaForAccount('3700', 'debit')).toBe('R1')
      expect(findRutaForAccount('3731', 'debit')).toBe('R1')
      expect(findRutaForAccount('3799', 'debit')).toBe('R1')
    })
  })

  describe('R2 - Momsfria intäkter', () => {
    it('includes 3100', () => {
      expect(findRutaForAccount('3100')).toBe('R2')
    })

    it('includes 3900 (Övriga rörelseintäkter)', () => {
      expect(findRutaForAccount('3900')).toBe('R2')
    })

    it('includes 3910 (Hyresintäkter)', () => {
      expect(findRutaForAccount('3910')).toBe('R2')
    })

    it('includes 3920 (Provisionsintäkter)', () => {
      expect(findRutaForAccount('3920')).toBe('R2')
    })

    it('includes 3950 (Återvunna kundfordringar)', () => {
      expect(findRutaForAccount('3950')).toBe('R2')
    })

    it('includes 3960 (Valutakursvinster)', () => {
      expect(findRutaForAccount('3960')).toBe('R2')
    })

    it('includes 3970-3980 range', () => {
      expect(findRutaForAccount('3970')).toBe('R2')
      expect(findRutaForAccount('3980')).toBe('R2')
    })

    it('includes 3981-3999 range', () => {
      expect(findRutaForAccount('3981')).toBe('R2')
      expect(findRutaForAccount('3990')).toBe('R2')
      expect(findRutaForAccount('3999')).toBe('R2')
    })
  })

  describe('R3 - Bil- och bostadsförmån', () => {
    it('takes no account, BAS has none for it', () => {
      for (let n = 3000; n <= 8999; n++) {
        expect(findRutaForAccount(String(n))).not.toBe('R3')
      }
    })
  })

  describe('R4 - Ränteintäkter m.m.', () => {
    it('includes 38xx (Aktiverat arbete för egen räkning)', () => {
      expect(findRutaForAccount('3800')).toBe('R4')
      expect(findRutaForAccount('3899')).toBe('R4')
    })

    it('includes interest and dividend income', () => {
      expect(findRutaForAccount('8310')).toBe('R4')
      expect(findRutaForAccount('8314')).toBe('R4')
      expect(findRutaForAccount('8010')).toBe('R4')
      expect(findRutaForAccount('8250')).toBe('R4')
    })
  })

  describe('R5 - Varor, material och tjänster', () => {
    it('includes 4000-4999', () => {
      expect(findRutaForAccount('4000', 'debit')).toBe('R5')
      expect(findRutaForAccount('4990', 'debit')).toBe('R5')
      expect(findRutaForAccount('4999', 'debit')).toBe('R5')
    })
  })

  describe('R6 - Övriga externa kostnader', () => {
    it('includes the whole of 5000-6999', () => {
      expect(findRutaForAccount('5010', 'debit')).toBe('R6')
      expect(findRutaForAccount('6990', 'debit')).toBe('R6')
      expect(findRutaForAccount('6999', 'debit')).toBe('R6')
    })

    it('includes 6991 and 6992 (avdragsgilla and ej avdragsgilla)', () => {
      expect(findRutaForAccount('6991', 'debit')).toBe('R6')
      expect(findRutaForAccount('6992', 'debit')).toBe('R6')
    })
  })

  describe('R7 - Anställd personal', () => {
    it('includes 7000-7699', () => {
      expect(findRutaForAccount('7010', 'debit')).toBe('R7')
      expect(findRutaForAccount('7699', 'debit')).toBe('R7')
    })
  })

  describe('R8 - Räntekostnader m.m.', () => {
    it('includes interest costs', () => {
      expect(findRutaForAccount('8410', 'debit')).toBe('R8')
      expect(findRutaForAccount('8423', 'debit')).toBe('R8')
    })

    it('includes 79xx (Övriga rörelsekostnader)', () => {
      expect(findRutaForAccount('7960', 'debit')).toBe('R8')
      expect(findRutaForAccount('7970', 'debit')).toBe('R8')
    })

    it('includes nedskrivningar of omsättningstillgångar (774x, 779x)', () => {
      expect(findRutaForAccount('7740', 'debit')).toBe('R8')
      expect(findRutaForAccount('7790', 'credit')).toBe('R8')
    })
  })

  describe('R9 and R10 - Av- och nedskrivningar', () => {
    it('puts byggnader, mark and förbättringsutgifter in R9', () => {
      expect(findRutaForAccount('7820', 'debit')).toBe('R9')
      expect(findRutaForAccount('7824', 'debit')).toBe('R9')
      expect(findRutaForAccount('7840', 'debit')).toBe('R9')
      expect(findRutaForAccount('7720', 'debit')).toBe('R9')
    })

    it('puts maskiner, inventarier and immateriella tillgångar in R10', () => {
      expect(findRutaForAccount('7810', 'debit')).toBe('R10')
      expect(findRutaForAccount('7832', 'debit')).toBe('R10')
      expect(findRutaForAccount('7730', 'debit')).toBe('R10')
      expect(findRutaForAccount('8850', 'debit')).toBe('R10')
    })
  })

  describe('groups split by the sign of the balance', () => {
    it('puts a valutakursvinst in R4 and a valutakursförlust in R8', () => {
      expect(findRutaForAccount('8330', 'credit')).toBe('R4')
      expect(findRutaForAccount('8330', 'debit')).toBe('R8')
      expect(findRutaForAccount('8430', 'credit')).toBe('R4')
      expect(findRutaForAccount('8430', 'debit')).toBe('R8')
    })

    it('puts a periodiseringsfond change by its sign', () => {
      expect(findRutaForAccount('8811', 'credit')).toBe('R4')
      expect(findRutaForAccount('8811', 'debit')).toBe('R8')
    })
  })

  describe('accounts are not silently dropped', () => {
    it('3500 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3500')).not.toBeNull()
    })

    it('3700 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3700')).not.toBeNull()
    })

    it('3910 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3910')).not.toBeNull()
    })

    it('3960 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3960')).not.toBeNull()
    })

    it('3990 is mapped (not dropped)', () => {
      expect(findRutaForAccount('3990')).not.toBeNull()
    })

    it('maps every result account in the bundled BAS chart, whatever the sign', () => {
      // koncernbidrag (882x-884x) are aktiebolag only and 899x holds the result itself
      const outsideNE = (n: string) => (n >= '8820' && n <= '8849') || n >= '8990'
      const unmapped = BAS_REFERENCE
        .map((account) => account.account_number)
        .filter((n) => n >= '3000' && n <= '8999' && !outsideNE(n))
        .filter((n) => findRutaForAccount(n, 'debit') === null || findRutaForAccount(n, 'credit') === null)
      expect(unmapped).toEqual([])
    })

    it('leaves koncernbidrag and the result account outside every ruta', () => {
      expect(findRutaForAccount('8820')).toBeNull()
      expect(findRutaForAccount('8999')).toBeNull()
    })
  })

  describe('no overlap between R1 and R2', () => {
    it('3100 is in R2 not R1', () => {
      expect(findRutaForAccount('3100')).toBe('R2')
    })

    it('3001 is in R1 not R2', () => {
      expect(findRutaForAccount('3001')).toBe('R1')
    })

    it('3900 is in R2 not R1', () => {
      expect(findRutaForAccount('3900')).toBe('R2')
    })
  })
})
