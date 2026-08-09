import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { requireAuth } from '../require-auth'
import { createClient } from '@/lib/supabase/server'

const CLAIMS = {
  iss: 'https://test.supabase.co/auth/v1',
  sub: 'user-1',
  aud: 'authenticated',
  exp: 9999999999,
  iat: 0,
  role: 'authenticated',
  aal: 'aal1',
  session_id: 'sess-1',
  email: 'test@test.se',
  is_anonymous: false,
  app_metadata: { provider: 'email' },
  user_metadata: {},
}

const MOCK_USER = {
  id: 'user-1',
  aud: 'authenticated',
  email: 'test@test.se',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}

type MockAuth = Record<string, unknown>

function useSupabase(auth: MockAuth) {
  const supabase = { auth }
  vi.mocked(createClient).mockResolvedValue(supabase as never)
  return supabase
}

describe('requireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Deterministic baseline: MFA off unless a test stubs it on.
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
    // Matches CLAIMS.iss so the fast path passes the issuer pinning.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses locally verified claims without calling getUser (fast path)', async () => {
    const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
    const getUser = vi.fn()
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(result.user?.email).toBe('test@test.se')
    expect(result.user?.app_metadata).toEqual({ provider: 'email' })
    expect(getUser).not.toHaveBeenCalled()
  })

  it('falls back to getUser when the client has no getClaims (legacy mocks)', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('returns 401 when neither claims nor getUser yield a user', async () => {
    const getClaims = vi.fn().mockResolvedValue({ data: null, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.user).toBeNull()
    expect(result.error?.status).toBe(401)
    const body = await result.error?.json()
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when getClaims throws (JWKS outage)', async () => {
    const getClaims = vi.fn().mockRejectedValue(new Error('jwks fetch failed'))
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when the claims issuer does not match the project URL', async () => {
    const claims = { ...CLAIMS, iss: 'https://evil.example.com/auth/v1' }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('falls back to getUser when the claims audience is not authenticated', async () => {
    const claims = { ...CLAIMS, aud: 'something-else' }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn().mockResolvedValue({ data: { user: MOCK_USER }, error: null })
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('accepts an array audience containing authenticated', async () => {
    const claims = { ...CLAIMS, aud: ['authenticated', 'other'] }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getUser = vi.fn()
    useSupabase({ getClaims, getUser })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getUser).not.toHaveBeenCalled()
  })

  it('returns 403 when MFA is required and AAL2 is not verified', async () => {
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
    const getAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    useSupabase({ getClaims, mfa: { getAuthenticatorAssuranceLevel } })

    const result = await requireAuth()

    expect(result.user).toBeNull()
    expect(result.error?.status).toBe(403)
    const body = await result.error?.json()
    expect(body).toEqual({ error: 'MFA verification required' })
  })

  it('skips the MFA check for bankid_linked users', async () => {
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const claims = { ...CLAIMS, app_metadata: { provider: 'email', bankid_linked: true } }
    const getClaims = vi.fn().mockResolvedValue({ data: { claims }, error: null })
    const getAuthenticatorAssuranceLevel = vi.fn()
    useSupabase({ getClaims, mfa: { getAuthenticatorAssuranceLevel } })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled()
  })

  it('passes when MFA is required and the session is already AAL2', async () => {
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const getClaims = vi.fn().mockResolvedValue({ data: { claims: CLAIMS }, error: null })
    const getAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    })
    useSupabase({ getClaims, mfa: { getAuthenticatorAssuranceLevel } })

    const result = await requireAuth()

    expect(result.error).toBeNull()
    expect(result.user?.id).toBe('user-1')
    expect(getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(1)
  })
})
