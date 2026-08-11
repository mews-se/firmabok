import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const deadlineMocks = vi.hoisted(() => ({
  regenerate: vi.fn().mockResolvedValue({ created: 1, deleted: 0 }),
}))

vi.mock('@/lib/tax/deadline-generator', () => ({
  regenerateTaxDeadlinesForUser: deadlineMocks.regenerate,
  toDeadlineSettings: vi.fn((settings: Record<string, unknown>) => settings),
}))

// Keep the real CompanyContextError so instanceof checks in switchCompany
// see the same class the tests throw.
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  setActiveCompany: vi.fn().mockResolvedValue(undefined),
}))

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { createCompanyFromOnboarding, switchCompany } from '../actions'

const mockCreateClient = vi.mocked(createClient)
const mockSetActiveCompany = vi.mocked(setActiveCompany)

type CapturedCall = { table: string; method: string; args: unknown[] }

/**
 * Builds a chainable Supabase mock that records every method call, allows
 * per-table result seeding, and returns a capture log the test can assert on.
 *
 * - `results[table][method]` (optional) is returned when the chain ends on
 *   that method. Chains otherwise resolve to `{ data: null, error: null }`.
 * - Unknown methods on the chain no-op and return the chain so callers can
 *   keep chaining freely.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  results?: Record<string, Record<string, { data?: unknown; error?: unknown }>>
  rpcResults?: Record<string, { data?: unknown; error?: unknown }>
}) {
  const calls: CapturedCall[] = []
  const { user, results = {}, rpcResults = {} } = opts

  function makeChain(table: string) {
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
    }
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        record(m, args)
        const canTerminate = results[table]?.[m]
        if (canTerminate) {
          return Promise.resolve({
            data: canTerminate.data ?? null,
            error: canTerminate.error ?? null,
          })
        }
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return chain
  }

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockImplementation((name: string) => {
      const result = rpcResults[name]
      if (result) {
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }

  return { supabase, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  deadlineMocks.regenerate.mockResolvedValue({ created: 1, deleted: 0 })
})

describe('switchCompany', () => {
  it('returns {} when the switch persists', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await switchCompany('company-2')

    expect(result).toEqual({})
    expect(mockSetActiveCompany).toHaveBeenCalledWith(supabase, 'user-1', 'company-2')
  })

  it('returns Unauthorized when there is no user', async () => {
    const { supabase } = buildSupabase({ user: null })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('maps a membership failure to the not_member code', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('User is not a member of this company', 'not_member'),
    )

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'not_member' })
  })

  it('maps a failed user_preferences write to persist_failed, not a permissions error (#701)', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('Failed to persist active company: timeout', 'persist_failed'),
    )

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'persist_failed' })
  })

  it('maps unexpected errors to persist_failed rather than claiming missing access', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(new Error('cookies unavailable'))

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'persist_failed' })
  })
})

describe('createCompanyFromOnboarding: org_number validation', () => {
  it('rejects malformed org_numbers at the guard boundary', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Broken AB',
        org_number: 'abc123', // not a 10- or 12-digit number
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    // Must NOT have reached the create RPC: otherwise we'd save a malformed
    // org_number and poison SIE/SRU exports.
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
  })

  it('rejects right-length org_numbers with invalid Luhn check digit', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Fake AB',
        // 10 digits but Luhn check digit is wrong (real Volvo is 5560125790;
        // the trailing 1 is an intentional off-by-one). Skatteverket SRU
        // validators and receiving SIE4 consumers would reject this, so we
        // refuse at the boundary.
        org_number: '5560125791',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
  })
})

