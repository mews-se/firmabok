/**
 * Tests for the shared declaration-prep functions. These are the single
 * source of truth for what gets filed to Skatteverket: the HTTP route
 * handlers and the commit-side services both go through them, so a regression
 * here would mean different numbers filed than the user reviewed (no-drift
 * compliance guarantee).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { VatDeclarationRutor } from '@/types'

const mockCalculateVatDeclaration = vi.fn()
const mockResolvePeriodDates = vi.fn()
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...a: unknown[]) => mockCalculateVatDeclaration(...a),
  resolvePeriodDates: (...a: unknown[]) => mockResolvePeriodDates(...a),
}))

import { buildMomsuppgift, resolveRedovisare } from '../lib/declaration-prep'
import { rutorToMomsuppgift } from '../lib/mappers'

const READ_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32',
  'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40', 'ruta41', 'ruta42',
  'ruta48', 'ruta50', 'ruta60', 'ruta61', 'ruta62',
]

function zeroRutor(): VatDeclarationRutor {
  return Object.fromEntries(READ_KEYS.map((k) => [k, 0])) as unknown as VatDeclarationRutor
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveRedovisare', () => {
  it('formats an aktiebolag org number to the 12-digit redovisare', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })
    const redovisare = await resolveRedovisare(supabase as never, 'company-1')
    expect(redovisare).toBe('165560000000')
  })

  it('throws when org number is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: null, entity_type: 'aktiebolag' } })
    await expect(resolveRedovisare(supabase as never, 'company-1')).rejects.toThrow(/Organisationsnummer saknas/)
  })
})

describe('buildMomsuppgift', () => {
  it('produces the same momsuppgift the route handler would (rutorToMomsuppgift over the GL rutor)', async () => {
    const rutor = zeroRutor()
    rutor.ruta10 = 250 // output VAT 25%
    rutor.ruta48 = 100 // input VAT
    mockCalculateVatDeclaration.mockResolvedValue({ rutor })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', { periodType: 'monthly', year: 2025, period: 3 })

    expect(result.redovisare).toBe('165560000000')
    expect(result.redovisningsperiod).toBe('202503')
    // Identical to the direct mapper output: locks the no-drift guarantee.
    expect(result.momsuppgift).toEqual(rutorToMomsuppgift(rutor))
    expect(result.momsuppgift.momsForsaljningUtgaendeHog).toBe(250)
    expect(result.momsuppgift.ingaendeMomsAvdrag).toBe(100)
    expect(result.momsuppgift.summaMoms).toBe(150)
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'monthly', 2025, 3, { fiscalPeriodId: undefined },
    )
    // Sub-annual periods are calendar periods: no fiscal-period lookup.
    expect(mockResolvePeriodDates).not.toHaveBeenCalled()
  })

  it('targets the FY-end month for a broken-FY yearly filer (SFL 26 kap 10-11 §§)', async () => {
    mockCalculateVatDeclaration.mockResolvedValue({ rutor: zeroRutor() })
    // Räkenskapsår 2025-07-01 → 2026-06-30: redovisningsperiod is 202606, not 202612.
    mockResolvePeriodDates.mockResolvedValue({ start: '2025-07-01', end: '2026-06-30' })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId: 'fp-1',
    })

    expect(result.redovisningsperiod).toBe('202606')
    expect(mockResolvePeriodDates).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1, 'fp-1',
    )
    // The figures must describe the same räkenskapsår as the period id.
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' },
    )
  })

  it('keeps the calendar-year fallback for yearly without a fiscal period', async () => {
    mockCalculateVatDeclaration.mockResolvedValue({ rutor: zeroRutor() })
    mockResolvePeriodDates.mockResolvedValue({ start: '2025-01-01', end: '2025-12-31' })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly', year: 2025, period: 1,
    })

    expect(result.redovisningsperiod).toBe('202512')
  })
})
