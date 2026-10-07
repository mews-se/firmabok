import { describe, it, expect } from 'vitest'
import { TAX_DEADLINE_CONFIGS } from '../deadline-config'
import type { CompanySettingsForDeadlines } from '../deadline-config'

function getConfig(type: string) {
  return TAX_DEADLINE_CONFIGS.find((c) => c.type === type)!
}

function makeSettings(overrides: Partial<CompanySettingsForDeadlines> = {}): CompanySettingsForDeadlines {
  return {
    entity_type: 'aktiebolag',
    moms_period: 'quarterly',
    f_skatt: true,
    preliminary_tax_monthly: 5000,
    vat_registered: true,
    fiscal_year_start_month: 1,
    vat_taxable_base_over_40m: false,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic',
    periodisk_sammanstallning_enabled: false,
    periodisk_sammanstallning_period: 'monthly',
    periodisk_sammanstallning_filing_method: 'electronic',
    rot_rut_enabled: false,
    fyllnadsinbetalning_enabled: false,
    tax_assessment_notices: [],
    ...overrides,
  }
}

describe('VAT filing deadlines', () => {
  it('uses the second following month for monthly filers at or below SEK 40 million', () => {
    const dates = getConfig('moms_monthly').generateDates(2026, makeSettings({ moms_period: 'monthly' }))

    expect(dates[0]).toMatchObject({ day: 12, month: 2, year: 2026, period: '2026-01' })
    expect(dates[10]).toMatchObject({ day: 17, month: 0, year: 2027, period: '2026-11' })
  })

  it('uses the following month for monthly filers above SEK 40 million', () => {
    const dates = getConfig('moms_monthly').generateDates(2026, makeSettings({
      moms_period: 'monthly',
      vat_taxable_base_over_40m: true,
    }))

    expect(dates[0]).toMatchObject({ day: 26, month: 1, year: 2026, period: '2026-01' })
    // Raw date stays the 26th even in December; the banking-day adjustment
    // in the generator moves annandag jul to Skatteverket's published 27th.
    expect(dates[10]).toMatchObject({ day: 26, month: 11, year: 2026, period: '2026-11' })
  })

  it('uses May, August, November and February for quarterly VAT', () => {
    const dates = getConfig('moms_quarterly').generateDates(2026, makeSettings())

    expect(dates.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 4, year: 2026 },
      { day: 17, month: 7, year: 2026 },
      { day: 12, month: 10, year: 2026 },
      { day: 12, month: 1, year: 2027 },
    ])
  })

  it('uses the entity, EU-trade and filing-method rules for yearly VAT', () => {
    const config = getConfig('moms_yearly')

    expect(config.generateDates(2027, makeSettings({
      entity_type: 'enskild_firma',
      moms_period: 'yearly',
    }))[0]).toMatchObject({ day: 12, month: 4, year: 2027, period: '2026' })
    expect(config.generateDates(2027, makeSettings({
      entity_type: 'enskild_firma',
      moms_period: 'yearly',
      vat_has_eu_trade: true,
    }))[0]).toMatchObject({ day: 26, month: 1, year: 2027, period: '2026' })
    expect(config.generateDates(2027, makeSettings({
      moms_period: 'yearly',
      vat_filing_method: 'paper',
    }))[0]).toMatchObject({ day: 12, month: 6, year: 2027, period: '2026' })
  })
})

describe('monthly preliminary tax deadlines', () => {
  it('generates preliminary tax deadlines only when an amount is debited', () => {
    const config = getConfig('f_skatt')
    // F-skatt approval alone carries no payment obligation.
    expect(config.condition(makeSettings({ preliminary_tax_monthly: null }))).toBe(false)
    expect(config.condition(makeSettings({ preliminary_tax_monthly: 0 }))).toBe(false)
    expect(config.condition(makeSettings({ preliminary_tax_monthly: 2500 }))).toBe(true)
    // The debited amount governs even without F-skatt approval (SA-skatt).
    expect(config.condition(makeSettings({ f_skatt: false, preliminary_tax_monthly: 2500 }))).toBe(true)
  })

  it('uses the 12th for preliminary tax except January and August', () => {
    const dates = getConfig('f_skatt').generateDates(2026, makeSettings())
    expect(dates[0].day).toBe(17)
    expect(dates[1].day).toBe(12)
    expect(dates[7].day).toBe(17)
  })

  it('keeps the 12th in August for storföretag preliminary tax (January-only 17th)', () => {
    const dates = getConfig('f_skatt').generateDates(2026, makeSettings({
      moms_period: 'monthly',
      vat_taxable_base_over_40m: true,
    }))
    expect(dates[0].day).toBe(17)
    expect(dates[7].day).toBe(12)
  })
})

describe('periodic EU sales list deadlines', () => {
  const config = getConfig('periodisk_sammanstallning')

  it('is only applicable when explicitly enabled', () => {
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ periodisk_sammanstallning_enabled: true }))).toBe(true)
  })

  it('uses the 25th monthly for electronic filing', () => {
    const dates = config.generateDates(2026, makeSettings({
      periodisk_sammanstallning_enabled: true,
    }))
    expect(dates).toHaveLength(12)
    expect(dates[0]).toMatchObject({ day: 25, month: 1, year: 2026, period: '2026-01' })
  })

  it('uses the 20th quarterly for paper filing', () => {
    const dates = config.generateDates(2026, makeSettings({
      periodisk_sammanstallning_enabled: true,
      periodisk_sammanstallning_period: 'quarterly',
      periodisk_sammanstallning_filing_method: 'paper',
    }))
    expect(dates).toHaveLength(4)
    expect(dates[0]).toMatchObject({ day: 20, month: 3, year: 2026, period: '2026-Q1' })
  })
})

describe('rot_rut_begaran: 31 January after the payment year (Lag 2009:194 8 §)', () => {
  const config = getConfig('rot_rut_begaran')

  it('is only applicable when explicitly enabled', () => {
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ rot_rut_enabled: true }))).toBe(true)
  })

  it('generates a 31 January row only for years with ROT/RUT payments', () => {
    const settings = makeSettings({
      rot_rut_enabled: true,
      rot_rut_payment_years: [2026],
    })
    expect(config.generateDates(2027, settings)).toEqual([
      { day: 31, month: 0, year: 2027, period: '2026', periodLabel: '2026' },
    ])
    // No payments in 2027 → no row for the 2028 deadline year.
    expect(config.generateDates(2028, settings)).toEqual([])
  })

  it('generates nothing when payment years are unknown (pure-settings contexts)', () => {
    // Backfill detection passes settings without the derived field: the
    // deadline must never be "expected" there, or the nightly cron would
    // regenerate (and status-reset) the company every day.
    const settings = makeSettings({ rot_rut_enabled: true })
    expect(config.generateDates(2027, settings)).toEqual([])
  })
})

describe('long-tail opt-in deadlines', () => {
  it('kvarskatt copies the exact notice date and never applies a banking-day shift', () => {
    const config = getConfig('kvarskatt')
    const settings = makeSettings({
      tax_assessment_notices: [{
        id: 'notice-1',
        fiscalPeriodName: '2029',
        decisionType: 'final',
        paymentDueDate: '2030-03-31',
      }],
    })

    expect(config.condition(settings)).toBe(true)
    expect(config.skipBankingDayAdjustment).toBe(true)
    expect(config.generateDates(2030, settings)).toEqual([{
      day: 31,
      month: 2,
      year: 2030,
      period: 'notice:notice-1',
      periodLabel: 'slutskattebesked, 2029',
      taxAssessmentNoticeId: 'notice-1',
    }])
  })

  it('fyllnadsinbetalning: 12th of 2nd month over 30k, 3rd of 5th month for the rest (SFL 62:8, 65 kap.)', () => {
    const config = getConfig('fyllnadsinbetalning')
    // Calendar FY 2030: 12 Feb 2031 and 3 May 2031.
    const dates = config.generateDates(2031, makeSettings({ fyllnadsinbetalning_enabled: true }))
    expect(dates.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 1, year: 2031 },
      { day: 3, month: 4, year: 2031 },
    ])
    expect(dates[0].period).toBe('2030-over30k')
    expect(dates[1].period).toBe('2030-rest')

    // Broken FY ending June 2030 (start July): 12 Aug 2030 and 3 Nov 2030.
    const broken = config.generateDates(2030, makeSettings({
      fyllnadsinbetalning_enabled: true,
      fiscal_year_start_month: 7,
    }))
    expect(broken.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 7, year: 2030 },
      { day: 3, month: 10, year: 2030 },
    ])
  })
})
