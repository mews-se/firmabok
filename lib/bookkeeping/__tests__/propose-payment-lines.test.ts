import { describe, it, expect } from 'vitest'
import { proposePaymentLines } from '../propose-payment-lines'
import type { InvoiceItem, VatTreatment } from '@/types'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    sort_order: 0,
    created_at: '2025-01-01',
    ...overrides,
  }
}

function makeInvoiceInput(overrides: Partial<{
  invoice_number: string
  total: number
  total_sek: number | null
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  currency: string
  exchange_rate: number | null
  vat_treatment: VatTreatment
  items: InvoiceItem[]
}> = {}) {
  return {
    invoice_number: '2025-001',
    total: 12500,
    total_sek: null,
    subtotal: 10000,
    subtotal_sek: null,
    vat_amount: 2500,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25' as VatTreatment,
    items: [makeItem()],
    ...overrides,
  }
}

describe('proposePaymentLines', () => {
  describe('accrual method', () => {
    it('SEK invoice → 2 lines (debit payment account, credit 1510)', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(2)
      expect(lines[0]).toEqual({
        account_number: '1930',
        debit_amount: '12500',
        credit_amount: '',
        line_description: 'Betalning faktura 2025-001',
      })
      expect(lines[1]).toEqual({
        account_number: '1510',
        debit_amount: '',
        credit_amount: '12500',
        line_description: 'Betalning faktura 2025-001',
      })
    })

    it('custom bank account (1920) → debit goes to 1920', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        paymentAccount: '1920',
      })

      expect(lines).toHaveLength(2)
      expect(lines[0].account_number).toBe('1920')
      expect(lines[1].account_number).toBe('1510')
    })

    it('foreign currency with exchange rate gain → 3 lines', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        exchangeRateDifference: 500,
      })

      expect(lines).toHaveLength(3)
      // Bank: actual received = 10000 + 500 = 10500
      expect(lines[0].account_number).toBe('1930')
      expect(lines[0].debit_amount).toBe('10500')
      // Clear receivable at booked amount
      expect(lines[1].account_number).toBe('1510')
      expect(lines[1].credit_amount).toBe('10000')
      // Exchange gain
      expect(lines[2].account_number).toBe('3960')
      expect(lines[2].credit_amount).toBe('500')
    })

    it('foreign currency with exchange rate loss → 3 lines with 7960 debit', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        exchangeRateDifference: -300,
      })

      expect(lines).toHaveLength(3)
      expect(lines[0].debit_amount).toBe('9700')
      expect(lines[2].account_number).toBe('7960')
      expect(lines[2].debit_amount).toBe('300')
    })
  })

  describe('cash method', () => {
    it('single VAT rate → debit 1930, credit 3001, credit 2611', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(3)
      expect(lines[0]).toEqual({
        account_number: '1930',
        debit_amount: '12500',
        credit_amount: '',
        line_description: 'Betalning faktura 2025-001',
      })
      expect(lines[1]).toEqual({
        account_number: '3001',
        debit_amount: '',
        credit_amount: '10000',
        line_description: 'Försäljning faktura 2025-001',
      })
      expect(lines[2]).toEqual({
        account_number: '2611',
        debit_amount: '',
        credit_amount: '2500',
        line_description: 'Utgående moms 25%',
      })
    })

    it('mixed VAT rates → multiple credit lines', () => {
      const items = [
        makeItem({ id: 'i1', vat_rate: 25, line_total: 8000, vat_amount: 2000, unit_price: 8000 }),
        makeItem({ id: 'i2', vat_rate: 12, line_total: 2000, vat_amount: 240, unit_price: 2000 }),
      ]

      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 12240,
          subtotal: 10000,
          vat_amount: 2240,
          items,
        }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      // 1 debit + 2 revenue + 2 VAT = 5 lines
      expect(lines).toHaveLength(5)
      expect(lines[0].account_number).toBe('1930')

      // Find the revenue/VAT lines by account
      const accounts = lines.slice(1).map((l) => l.account_number)
      expect(accounts).toContain('3001') // 25% revenue
      expect(accounts).toContain('2611') // 25% VAT
      expect(accounts).toContain('3002') // 12% revenue
      expect(accounts).toContain('2621') // 12% VAT
    })

    it('defaults payment account to 1930', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      expect(lines[0].account_number).toBe('1930')
    })

    it('uses custom payment account', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
        paymentAccount: '1910',
      })

      expect(lines[0].account_number).toBe('1910')
    })
  })
})

describe('proposePaymentLines: öresavrundning (3740)', () => {
  it('accrual: rounded-up total → bank leg at "Att betala", 3740 credit carries the residual', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1234.75,
        subtotal: 987.8,
        vat_amount: 246.95,
        items: [makeItem({ line_total: 987.8, vat_amount: 246.95, unit_price: 987.8 })],
      }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1235' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '1234.75' })
    expect(lines[2]).toEqual({
      account_number: '3740',
      debit_amount: '',
      credit_amount: '0.25',
      line_description: 'Öresavrundning',
    })
  })

  it('accrual: rounded-down total → 3740 debit', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 1234.25 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1234' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '1234.25' })
    expect(lines[2]).toMatchObject({ account_number: '3740', debit_amount: '0.25', credit_amount: '' })
  })

  it('cash: bank leg is the rounded amount and 3740 balances the exact revenue + VAT credits', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1234.75,
        subtotal: 987.8,
        vat_amount: 246.95,
        items: [makeItem({ line_total: 987.8, vat_amount: 246.95, unit_price: 987.8 })],
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1235' })
    const last = lines[lines.length - 1]
    expect(last).toMatchObject({ account_number: '3740', credit_amount: '0.25' })
    const debit = lines.reduce((s, l) => s + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((s, l) => s + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round((debit - credit) * 100)).toBe(0)
  })

  it('company setting off and no invoice override → unchanged 2-line proposal', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 1234.75 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: false,
    })

    expect(lines).toHaveLength(2)
    expect(lines[0].debit_amount).toBe('1234.75')
  })

  it('per-invoice override wins over the company setting', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput({ total: 1234.75 }), ore_rounding: true },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: false,
    })

    expect(lines).toHaveLength(3)
    expect(lines[2].account_number).toBe('3740')
  })

  it('whole-krona total → no 3740 line even when rounding is on', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 12500 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(2)
  })

  it('non-SEK invoice → rounding never applies', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1000.4,
        total_sek: 10004,
        currency: 'EUR',
        exchange_rate: 10,
      }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines.every((l) => l.account_number !== '3740')).toBe(true)
  })
})

describe('proposePaymentLines: dimensions propagation (PR7)', () => {
  const bag = { '1': 'KS01', '6': 'P001' }

  it('accrual: every proposed line carries a copy of the invoice default bag', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: bag },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
      // A copy, not the shared reference: editing one line must not mutate
      // the invoice bag or a sibling line.
      expect(line.dimensions).not.toBe(bag)
    }
    expect(lines[0].dimensions).not.toBe(lines[1].dimensions)
  })

  it('accrual with FX difference: the 3960 line carries the bag too', () => {
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        default_dimensions: bag,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      exchangeRateDifference: 500,
    })

    expect(lines).toHaveLength(3)
    expect(lines[2].account_number).toBe('3960')
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
    }
  })

  it('cash: payment, revenue and VAT lines all carry the bag', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: bag },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.account_number)).toEqual(['1930', '3001', '2611'])
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
    }
  })

  it('absent or empty bag → no dimensions key on any line', () => {
    const withoutBag = proposePaymentLines({
      invoice: makeInvoiceInput(),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })
    for (const line of withoutBag) {
      expect('dimensions' in line).toBe(false)
    }

    const withEmptyBag = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: {} },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })
    for (const line of withEmptyBag) {
      expect('dimensions' in line).toBe(false)
    }
  })
})

/**
 * The cash-method proposal IS the entry: PaymentBookingDialog pre-fills its
 * editable grid from these lines and submits them. A foreign invoice with no
 * exchange rate has no SEK value at item granularity, so pre-filling the raw
 * foreign numbers would post 1 000 kr of revenue and 250 kr of moms where 11 500
 * kr and 2 875 kr belong: balanced, undetectable, and an understated ruta 05/10.
 * The dialog resolves the proposal inside a try/catch, so throwing surfaces as a
 * translated toast (INVOICE_FX_RATE_MISSING) rather than a crash.
 */
describe('proposePaymentLines: foreign currency without an exchange rate', () => {
  it('cash method refuses with INVOICE_FX_RATE_MISSING', () => {
    expect(() =>
      proposePaymentLines({
        invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: null }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_FX_RATE_MISSING', currency: 'EUR' }))
  })

  it('cash method refuses a zero rate the same way', () => {
    expect(() =>
      proposePaymentLines({
        invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: 0 }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_FX_RATE_MISSING' }))
  })

  it('cash method with a rate proposes converted, balanced lines', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        currency: 'EUR',
        exchange_rate: 11.5,
        subtotal: 1000,
        vat_amount: 250,
        total: 1250,
        items: [makeItem({ line_total: 1000, unit_price: 1000, vat_rate: 25, vat_amount: 250 })],
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('14375')

    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  it('SEK cash method without a rate is unaffected', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ currency: 'SEK', exchange_rate: null }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('12500')
    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  // The invoice-level fallback (no items) reads subtotal_sek / vat_amount_sek and
  // is deliberately left lenient: those rows CAN be expressed in kronor.
  it('cash method still proposes from invoice-level *_sek when there are no items', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        currency: 'EUR',
        exchange_rate: null,
        items: [],
        subtotal: 1000,
        subtotal_sek: 11500,
        vat_amount: 250,
        vat_amount_sek: 2875,
        total: 1250,
        total_sek: 14375,
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('14375')
  })
})

describe('proposePaymentLines: one payment of the invoice', () => {
  const amounts = (lines: ReturnType<typeof proposePaymentLines>) =>
    lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
  const oreInvoice = makeInvoiceInput({
    total: 1234.56,
    subtotal: 987.65,
    vat_amount: 246.91,
    items: [makeItem({ line_total: 987.65, vat_amount: 246.91, unit_price: 987.65 })],
  })

  describe.each(['accrual', 'cash'] as const)('%s: the default amount for an unpaid invoice', (accountingMethod) => {
    it.each([
      ['öresavrundning on', true, oreInvoice, 1235],
      ['öresavrundning off', false, oreInvoice, 1234.56],
      ['a whole-krona total', true, makeInvoiceInput(), 12500],
    ])('proposes exactly what it did without an amount (%s)', (_label, companyOreRounding, invoice, paymentAmount) => {
      const base = { invoice, accountingMethod, entityType: 'enskild_firma' as const, companyOreRounding }

      expect(proposePaymentLines({ ...base, paymentAmount, priorPaidAmount: 0 })).toEqual(proposePaymentLines(base))
      expect(proposePaymentLines({ ...base, paymentAmount })).toEqual(proposePaymentLines(base))
    })
  })

  it('cash: 10 000 + 25 % moms paid with 9 999 and then 2 501', () => {
    const base = { invoice: makeInvoiceInput(), accountingMethod: 'cash' as const, entityType: 'enskild_firma' as const }

    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 9999, priorPaidAmount: 0 }))).toEqual([
      ['1930', '9999', ''],
      ['3001', '', '7999.2'],
      ['2611', '', '1999.8'],
    ])
    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 2501, priorPaidAmount: 9999 }))).toEqual([
      ['1930', '2501', ''],
      ['3001', '', '2000.8'],
      ['2611', '', '500.2'],
    ])
  })

  it('cash: settles inside the öre band with the difference on 3740', () => {
    const base = { invoice: oreInvoice, accountingMethod: 'cash' as const, entityType: 'enskild_firma' as const }

    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 1000, priorPaidAmount: 0 }))).toEqual([
      ['1930', '1000', ''],
      ['3001', '', '800'],
      ['2611', '', '200'],
    ])
    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 235, priorPaidAmount: 1000 }))).toEqual([
      ['1930', '235', ''],
      ['3001', '', '187.65'],
      ['2611', '', '46.91'],
      ['3740', '', '0.44'],
    ])
    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 234, priorPaidAmount: 1000 })).at(-1)).toEqual(['3740', '0.56', ''])
  })

  it('cash: a shortfall of 1 kr or more stays a partial without 3740', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput(),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
      paymentAmount: 12499,
      priorPaidAmount: 0,
    })

    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(lines[0].debit_amount).toBe('12499')
  })

  it('accrual: clears 1510 with the amount applied', () => {
    const base = { invoice: makeInvoiceInput(), accountingMethod: 'accrual' as const, entityType: 'enskild_firma' as const }

    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 5000, priorPaidAmount: 0 }))).toEqual([
      ['1930', '5000', ''],
      ['1510', '', '5000'],
    ])
    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 7500, priorPaidAmount: 5000 }))).toEqual([
      ['1930', '7500', ''],
      ['1510', '', '7500'],
    ])
    expect(
      amounts(proposePaymentLines({ ...base, invoice: oreInvoice, paymentAmount: 235, priorPaidAmount: 1000 })),
    ).toEqual([
      ['1930', '235', ''],
      ['1510', '', '234.56'],
      ['3740', '', '0.44'],
    ])
  })

  it('cash: books the excess of an overpayment as förskott on 2420', () => {
    const base = { invoice: makeInvoiceInput(), accountingMethod: 'cash' as const, entityType: 'enskild_firma' as const }

    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 13000, priorPaidAmount: 0 }))).toEqual([
      ['1930', '13000', ''],
      ['3001', '', '10000'],
      ['2611', '', '2500'],
      ['2420', '', '500'],
    ])
    expect(amounts(proposePaymentLines({ ...base, paymentAmount: 3000, priorPaidAmount: 9999 }))).toEqual([
      ['1930', '3000', ''],
      ['3001', '', '2000.8'],
      ['2611', '', '500.2'],
      ['2420', '', '499'],
    ])
  })

  it('accrual: proposes no 2420 for an overpayment', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput(),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      paymentAmount: 13000,
      priorPaidAmount: 0,
    })

    expect(lines.some((l) => l.account_number === '2420')).toBe(false)
  })

  it('stamps the default dimensions on a single payment too', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: { '6': 'P001' } },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
      paymentAmount: 5000,
      priorPaidAmount: 0,
    })

    expect(lines.every((l) => l.dimensions?.['6'] === 'P001')).toBe(true)
  })

  it('ignores the amount on a foreign-currency invoice', () => {
    const base = {
      invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: 11, total: 1250, total_sek: 13750 }),
      accountingMethod: 'cash' as const,
      entityType: 'enskild_firma' as const,
    }

    expect(proposePaymentLines({ ...base, paymentAmount: 500, priorPaidAmount: 0 })).toEqual(proposePaymentLines(base))
  })
})
