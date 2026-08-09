import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inbox-1',
    status: 'received',
    source: 'upload',
    created_at: '2026-08-01T10:00:00Z',
    document_id: 'doc-1',
    extracted_data: null,
    extraction_skipped: false,
    error_message: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    ...overrides,
  }
}

describe('GET /api/inbox', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/inbox'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('lists items with document info and extraction summary', async () => {
    enqueue({
      data: [
        makeItem({
          extracted_data: {
            supplier: { name: 'Acme AB' },
            totals: { total: 1250 },
            invoice: { currency: 'SEK', invoiceDate: '2026-07-28' },
          },
        }),
        // Document-less item (e.g. a failed intake) still renders.
        makeItem({ id: 'inbox-2', document_id: null }),
      ],
      count: 2,
    })
    enqueue({
      data: [
        { id: 'doc-1', file_name: 'acme.pdf', mime_type: 'application/pdf', file_size_bytes: 1000 },
      ],
    })

    const res = await GET(createMockRequest('/api/inbox'))
    const { status, body } = await parseJsonResponse<{
      data: Array<Record<string, unknown>>
      count: number
    }>(res)

    expect(status).toBe(200)
    expect(body.count).toBe(2)
    expect(body.data[0]).toMatchObject({
      id: 'inbox-1',
      file_name: 'acme.pdf',
      mime_type: 'application/pdf',
      supplier_name: 'Acme AB',
      amount: 1250,
      currency: 'SEK',
      invoice_date: '2026-07-28',
    })
    expect(body.data[1]).toMatchObject({
      id: 'inbox-2',
      file_name: null,
      supplier_name: null,
      amount: null,
    })
  })

  it('applies the pending predicate by default (status + no terminal links)', async () => {
    enqueue({ data: [], count: 0 })
    const res = await GET(createMockRequest('/api/inbox'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)

    const eqCalls = findCalls('invoice_inbox_items', 'eq')
    expect(eqCalls).toContainEqual(['status', 'received'])
    const isCalls = findCalls('invoice_inbox_items', 'is')
    expect(isCalls).toContainEqual(['created_supplier_invoice_id', null])
    expect(isCalls).toContainEqual(['created_journal_entry_id', null])
    expect(isCalls).toContainEqual(['matched_transaction_id', null])
    expect(isCalls).toContainEqual(['linked_journal_entry_id', null])
  })

  it('skips the pending predicate for status=all', async () => {
    enqueue({ data: [], count: 0 })
    const res = await GET(
      createMockRequest('/api/inbox', { searchParams: { status: 'all' } }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)
    expect(findCalls('invoice_inbox_items', 'eq')).not.toContainEqual(['status', 'received'])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([])
  })

  it('returns an error envelope when the query fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const res = await GET(createMockRequest('/api/inbox'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBeGreaterThanOrEqual(500)
  })
})
