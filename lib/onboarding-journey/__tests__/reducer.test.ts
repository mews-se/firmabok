import { describe, it, expect } from 'vitest'
import {
  initJourney,
  journeyReducer,
  stationOfStep,
  type JourneyAction,
  type JourneyState,
} from '../reducer'

function run(state: JourneyState, ...actions: JourneyAction[]): JourneyState {
  return actions.reduce(journeyReducer, state)
}

/** The manual walk through the Företaget station, parked on the fy step. */
function manualEfAtFy(): JourneyState {
  return run(
    initJourney(),
    { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
    { type: 'NAME_SUBMITTED', name: 'Testfirman' },
    { type: 'ADDRESS_SUBMITTED', addressLine1: 'Gatan 1', postalCode: '123 45', city: 'Lund' },
    { type: 'FSKATT_ANSWERED', fskatt: true },
  )
}

describe('initJourney', () => {
  it('presets enskild firma so the entity question never exists', () => {
    const s = initJourney()
    expect(s.step).toBe('orgnr')
    expect(s.settings.entity_type).toBe('enskild_firma')
  })

  it('keeps a deep-linked org number', () => {
    const s = initJourney({ initialOrgNumber: '556677-8899' })
    expect(s.settings.org_number).toBe('556677-8899')
  })
})

describe('journeyReducer: the Företaget station', () => {
  it('walks orgnr → name → address → F-skatt → fy', () => {
    let s = run(initJourney(), { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(s.step).toBe('name')
    s = journeyReducer(s, { type: 'NAME_SUBMITTED', name: 'Testfirman' })
    expect(s.step).toBe('address')
    s = journeyReducer(s, { type: 'ADDRESS_SUBMITTED', city: 'Lund' })
    expect(s.step).toBe('fskatt')
    s = journeyReducer(s, { type: 'FSKATT_ANSWERED', fskatt: false })
    expect(s.step).toBe('fy')
    expect(s.settings.f_skatt).toBe(false)
  })

  it('ignores an empty verksamhetsnamn', () => {
    const s = run(initJourney(), { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(journeyReducer(s, { type: 'NAME_SUBMITTED', name: '   ' })).toBe(s)
  })

  it('skipping the address still moves on but remembers it was asked', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'NAME_SUBMITTED', name: 'Testfirman' },
      { type: 'ADDRESS_SUBMITTED' },
    )
    expect(s.step).toBe('fskatt')
    expect(s.addressAsked).toBe(true)
    expect(s.settings.address_line1).toBeUndefined()
  })
})

describe('journeyReducer: fiscal-year branches', () => {
  it('calendar year confirmed goes straight to the moms question', () => {
    const s = journeyReducer(manualEfAtFy(), { type: 'FY_CALENDAR_CONFIRMED' })
    expect(s.step).toBe('momsyn')
    expect(s.settings.fiscal_year_start_month).toBe(1)
    expect(s.settings.is_first_fiscal_year).toBe(false)
  })

  it('first year: start + end dates, ongoing start month derived from the end', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-03-14' },
      { type: 'FY_END_PICKED', date: '2026-12-31' },
    )
    expect(s.settings).toMatchObject({
      is_first_fiscal_year: true,
      first_year_start: '2026-03-14',
      first_year_end: '2026-12-31',
      fiscal_year_start_month: 1,
    })
    expect(s.step).toBe('momsyn')
  })

  it('first year ending mid-year points the ongoing year at the next month', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-03-14' },
      { type: 'FY_END_PICKED', date: '2027-06-30' },
    )
    expect(s.settings.fiscal_year_start_month).toBe(7)
  })

  it('brutet år: end month picks the following start month', () => {
    const s = run(manualEfAtFy(), { type: 'FY_OTHER_SELECTED' }, { type: 'FY_END_MONTH_PICKED', endMonth: 6 })
    expect(s.settings.fiscal_year_start_month).toBe(7)
    expect(s.settings.is_first_fiscal_year).toBe(false)
  })

  it('brutet år resolving to December is a plain calendar year', () => {
    const s = run(manualEfAtFy(), { type: 'FY_OTHER_SELECTED' }, { type: 'FY_END_MONTH_PICKED', endMonth: 12 })
    expect(s.settings.fiscal_year_start_month).toBe(1)
  })
})

describe('journeyReducer: the moms station', () => {
  it('VAT yes derives the Swedish VAT number and asks for the period', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: true },
    )
    expect(s.step).toBe('moms')
    expect(s.settings.vat_registered).toBe(true)
    expect(s.settings.vat_number).toMatch(/^SE\d{10}01$/)
  })

  it('VAT no clears the number and the period and skips ahead', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: false },
    )
    expect(s.step).toBe('method')
    expect(s.settings.vat_registered).toBe(false)
    expect(s.settings.vat_number).toBeNull()
    expect(s.settings.moms_period).toBeNull()
  })
})

describe('journeyReducer: Back and station jumps', () => {
  it('Back restores each step to its ENTRY state (answers roll back)', () => {
    const atFy = manualEfAtFy()
    let s = journeyReducer(atFy, { type: 'BACK' })
    expect(s.step).toBe('fskatt')
    expect(s.settings.f_skatt).toBeUndefined()
    s = journeyReducer(s, { type: 'BACK' })
    expect(s.step).toBe('address')
    expect(s.settings.address_line1).toBeUndefined()
    expect(s.settings.city).toBeUndefined()
    s = journeyReducer(s, { type: 'BACK' })
    expect(s.step).toBe('name')
    expect(s.settings.company_name).toBeUndefined()
  })

  it('ignores Back while submitting and with empty history', () => {
    const fresh = initJourney()
    expect(journeyReducer(fresh, { type: 'BACK' })).toBe(fresh)
  })

  it('a station jump rewinds to the first step of that station', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: true },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'STATION_JUMP', station: 1 },
    )
    expect(s.step).toBe('fy')
    expect(s.settings.moms_period).toBeUndefined()
    expect(s.settings.fiscal_year_start_month).toBeUndefined()
    // The Företaget answers survive.
    expect(s.settings.company_name).toBe('Testfirman')
  })

  it('jumping to the Företaget station lands on the orgnr question', () => {
    const s = run(
      manualEfAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'STATION_JUMP', station: 0 },
    )
    expect(s.step).toBe('orgnr')
    expect(s.settings.company_name).toBeUndefined()
  })

  it('ignores jumps to the current or a later station', () => {
    const s = manualEfAtFy()
    expect(journeyReducer(s, { type: 'STATION_JUMP', station: 1 })).toBe(s)
    expect(journeyReducer(s, { type: 'STATION_JUMP', station: 3 })).toBe(s)
  })
})

describe('journeyReducer: server errors', () => {
  function submitted(): JourneyState {
    return run(
      manualEfAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: true },
      { type: 'MOMS_PERIOD_PICKED', period: 'monthly' },
      { type: 'METHOD_PICKED', method: 'cash' },
    )
  }

  it('org_number_invalid travels back to the orgnr question, keeping answers', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'org_number_invalid' })
    expect(s.step).toBe('orgnr')
    expect(s.serverError).toBe('org_number_invalid')
    expect(s.submitting).toBe(false)
    expect(s.settings.accounting_method).toBe('cash')
  })

  it('period_invalid returns to the fiscal-year station', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'period_invalid' })
    expect(s.step).toBe('fy')
    expect(s.serverError).toBe('period_invalid')
  })

  it('generic failure stays on method with a retry state', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'generic' })
    expect(s.step).toBe('method')
    expect(s.serverError).toBe('generic')
    expect(s.submitting).toBe(false)
  })

  it('any new answer clears the server error', () => {
    const failed = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'org_number_invalid' })
    const s = run(failed, { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(s.serverError).toBeNull()
  })

  it('a successful submit lands on done', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_SUCCEEDED' })
    expect(s.step).toBe('done')
    expect(stationOfStep(s.step)).toBe(4)
  })
})
