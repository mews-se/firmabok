import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
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

import { GET, PATCH } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = createMockRouteParams({ id: 'inbox-1' })

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
    extracted_data: { supplier: { name: 'Acme AB' } },
    extraction_skipped: false,
    error_message: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    channel_context: null,
    ...overrides,
  }
}

describe('GET /api/inbox/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/inbox/inbox-1'), routeParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when the item does not exist', async () => {
    enqueue({ data: null })
    const res = await GET(createMockRequest('/api/inbox/inbox-1'), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('returns the item with its document metadata', async () => {
    enqueue({ data: makeItem() })
    enqueue({
      data: { id: 'doc-1', file_name: 'kvitto.pdf', mime_type: 'application/pdf', file_size_bytes: 500 },
    })

    const res = await GET(createMockRequest('/api/inbox/inbox-1'), routeParams)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; extracted_data: unknown; document: { file_name: string } }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('inbox-1')
    expect(body.data.extracted_data).toEqual({ supplier: { name: 'Acme AB' } })
    expect(body.data.document.file_name).toBe('kvitto.pdf')
  })
})

describe('PATCH /api/inbox/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'dismiss' } }),
      routeParams,
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an unknown action', async () => {
    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'nuke' } }),
      routeParams,
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when the item does not exist', async () => {
    enqueue({ data: null })
    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'dismiss' } }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('refuses to dismiss a handled item', async () => {
    enqueue({ data: makeItem({ created_supplier_invoice_id: 'si-1' }) })
    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'dismiss' } }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_ALREADY_HANDLED')
  })

  it('dismiss parks the item as status=error', async () => {
    enqueue({ data: makeItem() })
    enqueue({ data: { id: 'inbox-1', status: 'error' } })

    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'dismiss' } }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('error')
    expect(findCall('invoice_inbox_items', 'update')).toEqual([{ status: 'error' }])
  })

  it('restore returns a dismissed item to received', async () => {
    enqueue({ data: makeItem({ status: 'error' }) })
    enqueue({ data: { id: 'inbox-1', status: 'received' } })

    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'restore' } }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('received')
    expect(findCall('invoice_inbox_items', 'update')).toEqual([{ status: 'received' }])
  })

  it('is idempotent: dismissing an already-dismissed item is a no-op success', async () => {
    enqueue({ data: makeItem({ status: 'error' }) })

    const res = await PATCH(
      createMockRequest('/api/inbox/inbox-1', { method: 'PATCH', body: { action: 'dismiss' } }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('error')
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })
})
