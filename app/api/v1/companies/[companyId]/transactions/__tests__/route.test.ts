/**
 * Integration tests for GET /api/v1/companies/:companyId/transactions
 * (list) and GET .../:id (detail).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`tx route tests require NODE_ENV=test`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listTransactions } from '../route'
import { GET as getTransaction } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/transactions', () => {
  it('returns a list with pagination metadata', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: [
            { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK', description: 'ICA' },
          ],
          error: null,
        },
      }),
    )

    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    // No next page → omitted (paginated() helper drops the key entirely
    // when nextCursor is undefined).
    expect(body.meta.next_cursor).toBeUndefined()
  })

  it('rejects invalid status filter with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listTransactions(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions?status=unknown`,
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without transactions:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/companies/:companyId/transactions/:id', () => {
  it('returns 200 with the transaction', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK' },
          error: null,
        },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(200)
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: null, error: null },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(404)
  })

  it('rejects non-UUID id with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/not-a-uuid`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(400)
  })
})
