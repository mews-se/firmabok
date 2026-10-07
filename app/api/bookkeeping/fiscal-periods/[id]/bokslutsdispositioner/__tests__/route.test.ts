import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/bokslut/dispositions-proposal-builder', () => ({
  buildDispositionsProposal: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { buildDispositionsProposal } from '@/lib/bokslut/dispositions-proposal-builder'
import { GET } from '../route'

const idParams = { params: Promise.resolve({ id: 'period-1' }) }

function get() {
  return GET(
    createMockRequest('/api/bookkeeping/fiscal-periods/period-1/bokslutsdispositioner'),
    idParams,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner', () => {
  it('returns the result before year-end', async () => {
    const proposal = {
      entityType: 'enskild_firma' as const,
      fiscalPeriod: {
        id: 'period-1',
        name: '2025',
        period_start: '2025-01-01',
        period_end: '2025-12-31',
      },
      netResultBefore: 592_722.21,
    }
    vi.mocked(buildDispositionsProposal).mockResolvedValue(proposal)

    const { status, body } = await parseJsonResponse(await get())

    expect(status).toBe(200)
    expect(body.data).toEqual(proposal)
    expect(buildDispositionsProposal).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1')
  })

  it('answers 404 when the period is not found', async () => {
    vi.mocked(buildDispositionsProposal).mockRejectedValue(new Error('Fiscal period not found'))

    const { status } = await parseJsonResponse(await get())

    expect(status).toBe(404)
  })
})
