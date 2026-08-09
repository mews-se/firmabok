import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(),
}))

import { requireWritePermission, getCompanyRole } from '../require-write'
import { getActiveCompanyId } from '@/lib/company/context'

describe('requireWritePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'owner' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for admin', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'admin' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok for member', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'member' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(true)
  })

  it('returns 403 for viewer', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'viewer' } })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('läsbehörighet')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: null })

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await requireWritePermission(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})

describe('getCompanyRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns role and companyId for owner', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'owner' } })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('owner')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns role for viewer (does not block)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: { role: 'viewer' } })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('viewer')
      expect(result.companyId).toBe('company-1')
    }
  })

  it('returns 403 when user has no membership', async () => {
    const { supabase, mockResult } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    mockResult({ data: null })

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
    }
  })

  it('returns 403 when there is no active company', async () => {
    const { supabase } = createMockSupabase()
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)

    const result = await getCompanyRole(supabase, 'user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json()
      expect(body.error).toContain('aktivt företag')
    }
  })
})
