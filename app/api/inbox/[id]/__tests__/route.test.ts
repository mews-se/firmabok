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

const deleteDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  deleteDocument: (...args: unknown[]) => deleteDocumentMock(...args),
}))

import { GET, PATCH, DELETE } from '../route'

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
    linked_journal_entry_id: null,
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

  it('refuses to dismiss an item whose document is linked to a verifikat', async () => {
    enqueue({ data: makeItem({ linked_journal_entry_id: 'je-1' }) })
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

describe('DELETE /api/inbox/[id]', () => {
  const del = () =>
    DELETE(createMockRequest('/api/inbox/inbox-1', { method: 'DELETE' }), routeParams)

  it('returns 404 when the item does not exist', async () => {
    enqueue({ data: null })
    const res = await del()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
    expect(deleteDocumentMock).not.toHaveBeenCalled()
  })

  it.each([
    ['created_supplier_invoice_id', { created_supplier_invoice_id: 'si-1' }],
    ['created_journal_entry_id', { created_journal_entry_id: 'je-1' }],
    ['matched_transaction_id', { matched_transaction_id: 'tx-1' }],
  ])('refuses when %s is set', async (_label, overrides) => {
    enqueue({ data: makeItem(overrides) })
    const res = await del()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_ALREADY_HANDLED')
    expect(deleteDocumentMock).not.toHaveBeenCalled()
  })

  it('deletes the row and its never-used document', async () => {
    enqueue({ data: makeItem() })
    enqueue({ data: { journal_entry_id: null, journal_entry_line_id: null } }) // doc link check
    enqueue({ data: null }) // row delete
    deleteDocumentMock.mockResolvedValue({ ok: true, document: { id: 'doc-1', file_name: 'x.pdf' } })

    const res = await del()
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(res)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
    expect(deleteDocumentMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'doc-1')
  })

  it('deletes the row but preserves a verifikat-linked document', async () => {
    // Trigger-maintained linked_journal_entry_id does not refuse: the row is
    // inbox cleanup, the document lives on as räkenskapsinformation.
    enqueue({ data: makeItem({ linked_journal_entry_id: 'je-1' }) })
    enqueue({ data: { journal_entry_id: 'je-1', journal_entry_line_id: null } }) // doc link check
    enqueue({ data: null }) // row delete

    const res = await del()
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(res)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
    expect(deleteDocumentMock).not.toHaveBeenCalled()
  })

  it('keeps the item when the document refuses deletion', async () => {
    // Race: the document got linked between the route's check and the delete;
    // deleteDocument's own guard still refuses and the row must survive.
    enqueue({ data: makeItem() })
    enqueue({ data: { journal_entry_id: null, journal_entry_line_id: null } }) // doc link check
    deleteDocumentMock.mockResolvedValue({
      ok: false,
      reason: 'linked_to_entry',
      status: 409,
      message: 'Underlaget är knutet till en verifikation och utgör räkenskapsinformation.',
    })

    const res = await del()
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(409)
    expect(findCalls('invoice_inbox_items', 'delete')).toEqual([])
  })
})
