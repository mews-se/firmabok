import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

import { POST } from '../route'

function mockUserClient(opts: {
  user: { id: string } | null
  updateUserError?: { message: string; status?: number; code?: string } | null
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = { auth: { updateUser } } as any

  if (opts.user) {
    requireAuthMock.mockResolvedValue({ user: opts.user, supabase, error: null })
  } else {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
  }

  return { updateUser }
}

const STRONG_PASSWORD = 'StrongP@ssword1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/account/password', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUserClient({ user: null })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(401)
  })

  it('returns 400 when password is too weak', async () => {
    const { updateUser } = mockUserClient({ user: { id: 'user-1' } })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: 'weak' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('writes the password via the user session', async () => {
    const { updateUser } = mockUserClient({ user: { id: 'user-1' } })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { ok: boolean }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data?.ok).toBe(true)
    expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
  })

  it('returns 400 when Supabase rejects the password update', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1' },
      updateUserError: { message: 'Password too similar to old', status: 400 },
    })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await POST(req),
    )

    expect(status).toBe(400)
    expect(body.error).toBe('Något gick fel. Försök igen.')
    expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
  })
})
