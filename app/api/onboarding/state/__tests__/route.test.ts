import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET, PATCH } from '../route'

describe('/api/onboarding/state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/onboarding/state'), {})
    expect(response.status).toBe(401)
  })

  it('returns the persisted company setup state', async () => {
    enqueue({
      data: {
        initial_setup_path: 'migration',
        initial_setup_completed_at: null,
        initial_setup_dismissed_at: null,
      },
    })

    const { status, body } = await parseJsonResponse<{
      data: { path: string; completedAt: string | null; dismissedAt: string | null }
    }>(await GET(createMockRequest('/api/onboarding/state'), {}))

    expect(status).toBe(200)
    expect(body.data).toEqual({ path: 'migration', completedAt: null, dismissedAt: null })
  })

  it('returns 400 for an empty update', async () => {
    const response = await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: {},
    }), {})

    expect(response.status).toBe(400)
  })

  it('returns 404 when company settings do not exist', async () => {
    enqueue({ data: null, error: null })
    const response = await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'bank' },
    }), {})

    expect(response.status).toBe(404)
  })

  it('persists a selected path and clears dismissal', async () => {
    enqueueMany([
      {
        data: {
          initial_setup_path: null,
          initial_setup_completed_at: null,
          initial_setup_dismissed_at: null,
        },
      },
      {
        data: {
          initial_setup_path: 'bank',
          initial_setup_completed_at: null,
          initial_setup_dismissed_at: null,
        },
      },
    ])

    const { status, body } = await parseJsonResponse<{
      data: { path: string; completedAt: string | null; dismissedAt: string | null }
    }>(await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'bank' },
    }), {}))

    expect(status).toBe(200)
    expect(body.data).toEqual({ path: 'bank', completedAt: null, dismissedAt: null })
  })
})
