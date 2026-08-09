/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warnRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn() }))

// log.warn is suppressed under NODE_ENV=test, so the failure-path tests
// observe it through this mock instead of a console spy.
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnRecorder,
    error: vi.fn(),
    child() {
      return this
    },
  }),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn().mockReturnValue({ stub: 'ctx' }),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn().mockResolvedValue(true),
}))

vi.mock('../lib/skattekonto-sync', () => ({
  syncSkattekonto: vi.fn(),
}))

// Real SkatteverketAuthError shape (message, code) without dragging the full
// api-client module (and its fetch plumbing) into the test.
vi.mock('../lib/api-client', () => ({
  SkatteverketAuthError: class SkatteverketAuthError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock('../lib/token-store', () => ({
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
  RECONSENT_ERROR_CODES: ['SESSION_EXPIRED', 'REFRESH_EXHAUSTED', 'MISSING_SCOPE', 'TOKEN_CORRUPTED'],
}))

import { runPostConnectRefresh } from '../lib/post-connect-refresh'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { syncSkattekonto } from '../lib/skattekonto-sync'
import { SkatteverketAuthError } from '../lib/api-client'
import { markNeedsReconsent } from '../lib/token-store'

const mockCreateExtensionContext = vi.mocked(createExtensionContext)
const mockHasCapability = vi.mocked(hasCapability)
const mockSyncSkattekonto = vi.mocked(syncSkattekonto)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)

const USER = 'user-1'
const COMPANY = 'company-1'

function makeSupabase() {
  return { from: vi.fn() } as any
}

describe('runPostConnectRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateExtensionContext.mockReturnValue({ stub: 'ctx' } as any)
    mockHasCapability.mockResolvedValue(true)
    mockSyncSkattekonto.mockResolvedValue({
      booked: 1,
      upcoming: 0,
      saldoSkatteverket: 100,
      saldoKronofogden: 0,
      syncedAt: '2026-07-12T21:30:00Z',
    } as any)
  })

  it('syncs on the happy path', async () => {
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: true })
    expect(mockCreateExtensionContext).toHaveBeenCalledWith(supabase, USER, COMPANY, 'skatteverket')
    expect(mockSyncSkattekonto).toHaveBeenCalledWith({ stub: 'ctx' })
  })

  it('does nothing when the skatteverket capability is not entitled', async () => {
    mockHasCapability.mockResolvedValueOnce(false)
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
  })

  it('reports synced=false and logs when the sync fails', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(new Error('SKV timeout'))
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false })
    // A plain network/timeout failure is transient: it must not flag the
    // freshly granted token as needing re-consent.
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
    const warned = warnRecorder.mock.calls.map(c => String(c[0]))
    expect(warned.some(m => m.includes('skattekonto sync failed'))).toBe(true)
  })

  it('persists needs_reconsent when the sync hits a terminal auth error (MISSING_SCOPE)', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('The required scopes are not authorized', 'MISSING_SCOPE'),
    )
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result.synced).toBe(false)
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(supabase, USER, 'MISSING_SCOPE')
  })

  it('does not persist needs_reconsent for non-terminal auth error codes', async () => {
    mockSyncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('temporary auth hiccup', 'NOT_CONNECTED'),
    )
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result.synced).toBe(false)
    expect(mockMarkNeedsReconsent).not.toHaveBeenCalled()
  })

  it('never throws when the capability check itself fails', async () => {
    mockHasCapability.mockRejectedValueOnce(new Error('db down'))
    const supabase = makeSupabase()

    const result = await runPostConnectRefresh(supabase, USER, COMPANY)

    expect(result).toEqual({ synced: false })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
  })
})
