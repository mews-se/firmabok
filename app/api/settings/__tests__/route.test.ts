import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const deadlineMocks = vi.hoisted(() => ({
  regenerate: vi.fn().mockResolvedValue(undefined),
}))

// Mock only the function that writes to the database. The field detector,
// settings normalizer, and regeneration predicate stay real so these tests
// fail if a new tax-relevant field stops triggering regeneration.
vi.mock('@/lib/tax/deadline-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tax/deadline-generator')>()
  return {
    ...actual,
    regenerateTaxDeadlinesForUser: deadlineMocks.regenerate,
  }
})

import { PUT } from '../route'
import { regenerateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'

describe('PUT /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('updates the settings on the happy path', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: false } }, // fetch oldSettings
      { data: { id: 's1', company_name: 'New Name' } },                        // update ... returning
      { data: null, count: 5 },                                                // deadlines count (has some -> no regen)
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { company_name: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.company_name).toBe('New Name')
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('updates invoice payment accounts', async () => {
    const updates = {
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'Example Bank',
          iban: 'SE0022222222222222222222',
          bic: 'EXAMSESS',
        },
      },
    }
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', ...updates } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: updates,
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: typeof updates }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject(updates)
  })

  it('rejects invoice payment instruction changes from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        invoice_payment_accounts: {
          SEK: { bankgiro: '123-4567' },
        },
        bankgiro: '123-4567',
      },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { required_roles?: string[] } }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details?.required_roles).toEqual(['owner', 'admin'])
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'company_settings',
      'company_members',
    ])
  })

  it('rejects a foreign payment account without IBAN', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', onboarding_complete: true } })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        invoice_payment_accounts: { EUR: { bank_name: 'Example Bank' } },
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('regenerates deadlines when unchanged tax settings are saved', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      moms_period: 'monthly',
      f_skatt: true,
      vat_registered: false,
      fiscal_year_start_month: 1,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: settings },
      { data: { id: 's1', ...settings } },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { f_skatt: true, vat_registered: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ entity_type: 'aktiebolag', f_skatt: true }),
    )
  })

  it('regenerates tax deadlines when the company has none yet (self-heal)', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } }, // oldSettings
      {
        data: {
          id: 's1',
          entity_type: 'aktiebolag',
          moms_period: 'quarterly',
          f_skatt: true,
          vat_registered: true,
          fiscal_year_start_month: 1,
        },
      }, // update
      { data: null, count: 0 }, // no system deadlines -> self-heal generation
    ])

    // A save with NO tax-relevant field: only the zero-count self-heal path
    // can trigger regeneration here.
    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Self Heal AB' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(vi.mocked(regenerateTaxDeadlinesForUser)).toHaveBeenCalledOnce()
  })

  it('clears VAT-dependent flags when VAT registration is turned off', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      vat_registered: true,
      vat_number: 'SE556012579001',
      moms_period: 'quarterly',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: true,
      periodisk_sammanstallning_enabled: true,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: settings },
      {
        data: {
          ...settings,
          id: 's1',
          vat_registered: false,
          vat_has_eu_trade: false,
          periodisk_sammanstallning_enabled: false,
        },
      },
    ])

    // Without the coercion this request 400s: the stored PS flag stays
    // effective while registration is being switched off.
    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_registered: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledOnce()
  })

  it('still rejects explicitly enabling the EU sales list without EU trade', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        vat_has_eu_trade: false,
        onboarding_complete: true,
      },
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { periodisk_sammanstallning_enabled: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
  })

  it('does not regenerate tax deadlines when the company already has some', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } }, // oldSettings
      { data: { id: 's1', entity_type: 'aktiebolag' } },                   // update
      { data: null, count: 12 },                                           // already has deadlines
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Unchanged Tax' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(vi.mocked(regenerateTaxDeadlinesForUser)).not.toHaveBeenCalled()
  })

  it('rejects quarterly VAT when the VAT taxable base is above SEK 40 million', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        vat_taxable_base_over_40m: false,
        onboarding_complete: true,
      },
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_taxable_base_over_40m: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('allows EU-trade changes with quarterly VAT and regenerates deadlines', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      vat_registered: true,
      vat_number: 'SE556012579001',
      moms_period: 'quarterly',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: true,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: { ...settings, vat_has_eu_trade: false } },
      { data: settings },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_has_eu_trade: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledOnce()
  })

  it('returns 404 when the settings row does not exist', async () => {
    enqueueMany([
      { data: { onboarding_complete: false } },
      { data: null, error: { code: 'PGRST116', message: 'No rows returned' } },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Unchanged' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })
})
