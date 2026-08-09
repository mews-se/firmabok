import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// The route delegates everything to replaceSIEImport (which itself runs the
// replace_sie_import RPC on the service client). The route's own contract is
// what these tests pin: auth, the 403 mapping of the RPC's authorization
// raise, the 400 fallback, and the success envelope.
const replaceSIEImportMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  replaceSIEImport: (...args: unknown[]) => replaceSIEImportMock(...args),
}))

import { POST } from '../route'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeReq() {
  return new Request('http://localhost/api/import/sie/import-1/replace', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
})

describe('POST /api/import/sie/[id]/replace', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'import-1' }))
    expect(res.status).toBe(401)
    expect(replaceSIEImportMock).not.toHaveBeenCalled()
  })

  it('maps the RPC authorization raise (42501) to 403 SIE_REPLACE_FORBIDDEN', async () => {
    // replaceSIEImport flattens the PostgREST error into a message string, so
    // the route matches the raise text pinned by migration 20260727120000.
    replaceSIEImportMock.mockResolvedValue({
      success: false,
      deletedEntries: 0,
      error: 'Kunde inte ersätta import: Only company owners and admins can replace SIE imports',
    })

    const res = await POST(makeReq(), createMockRouteParams({ id: 'import-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string }
    }>(res)

    expect(status).toBe(403)
    expect(body.error.code).toBe('SIE_REPLACE_FORBIDDEN')
    // Swedish user-facing message, not raw Postgres prose.
    expect(body.error.message).toBe(
      'Endast ägare eller administratörer kan ersätta en SIE-import.',
    )
  })

  it('returns 400 SIE_REPLACE_FAILED with the reason for other failures', async () => {
    replaceSIEImportMock.mockResolvedValue({
      success: false,
      deletedEntries: 0,
      error: 'Kan inte ersätta import i ett låst eller stängt räkenskapsår. Öppna perioden först.',
    })

    const res = await POST(makeReq(), createMockRouteParams({ id: 'import-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_REPLACE_FAILED')
    expect(body.error.details?.reason).toContain('låst eller stängt')
  })

  it('passes the authorising user through and returns the deleted count', async () => {
    replaceSIEImportMock.mockResolvedValue({ success: true, deletedEntries: 42 })

    const res = await POST(makeReq(), createMockRouteParams({ id: 'import-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      deletedEntries: number
    }>(res)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.deletedEntries).toBe(42)
    expect(replaceSIEImportMock).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'import-1',
      'user-1',
    )
  })
})
