import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeDocumentAttachment,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// Shared fs-backed storage bucket mock (lib/storage/local): tests steer
// individual methods via mockStorage(); beforeEach restores the defaults.
function storageDefaults() {
  return {
    createSignedUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://example.com/signed' },
      error: null,
    }),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
  }
}

const storageBucket: Record<string, unknown> = storageDefaults()

vi.mock('@/lib/storage/local', () => ({
  fileStorage: () => ({ from: () => storageBucket }),
}))

function mockStorage(overrides: Record<string, unknown>) {
  Object.assign(storageBucket, overrides)
}

import { GET, DELETE } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  // Reset write-permission mock to default ok
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
  mockStorage(storageDefaults())
})

function makeReq(method: 'GET' | 'DELETE' = 'DELETE') {
  return new Request('http://localhost/api/documents/doc-1', { method })
}

describe('GET /api/documents/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when the document is not found in the company', async () => {
    enqueue({ data: null, error: null }) // doc lookup
    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toBe('Document not found')
  })

  it('returns 500 when the signed URL cannot be created', async () => {
    enqueue({ data: makeDocumentAttachment({ id: 'doc-1' }), error: null })
    mockStorage({
      createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    })

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(500)
    expect(body.error).toContain('Failed to create download URL')
  })

  it('returns the document with a signed download URL and emits document.accessed', async () => {
    const row = makeDocumentAttachment({
      id: 'doc-1',
      file_name: 'kvitto.pdf',
      storage_path: 'documents/company-1/user-1/kvitto.pdf',
    })
    enqueue({ data: row, error: null })

    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://example.com/signed' },
      error: null,
    })
    mockStorage({ createSignedUrl })

    const handler = vi.fn()
    eventBus.on('document.accessed', handler)

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { id: string; download_url: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
    expect(body.data.download_url).toBe('https://example.com/signed')

    expect(createSignedUrl).toHaveBeenCalledWith('documents/company-1/user-1/kvitto.pdf', 3600)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: 'doc-1', file_name: 'kvitto.pdf' }),
        userId: 'user-1',
        companyId: 'company-1',
      }),
    )
  })

  it('signs attachments stored under another company member folder', async () => {
    // A colleague-uploaded document must be downloadable by every company
    // member: the company-scoped row fetch is the authorization, and the
    // storage backend signs whatever key that row points at.
    const row = makeDocumentAttachment({
      id: 'doc-2',
      file_name: 'leverantorsfaktura.pdf',
      storage_path: 'documents/company-1/other-member/leverantorsfaktura.pdf',
    })
    enqueue({ data: row, error: null })

    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://example.com/signed' },
      error: null,
    })
    mockStorage({ createSignedUrl })

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-2' }))
    const { status, body } = await parseJsonResponse<{
      data: { download_url: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.download_url).toBe('https://example.com/signed')
    expect(createSignedUrl).toHaveBeenCalledWith(
      'documents/company-1/other-member/leverantorsfaktura.pdf',
      3600,
    )
  })
})

describe('DELETE /api/documents/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('returns 404 when document not found in company', async () => {
    enqueue({ data: null, error: null }) // doc lookup
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns 409 with BFL message when doc is linked to a journal entry', async () => {
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: 'je-99',
        user_id: 'user-1',
      },
      error: null,
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toContain('Bokföringslagen')
    expect(body.error).toContain('7 kap')
  })

  it('deletes the row, removes Storage file, and emits document.deleted on unlinked doc', async () => {
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/company-1/user-1/kvitto.pdf',
        journal_entry_id: null,
        user_id: 'user-1',
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // delete

    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    mockStorage({ remove })

    const handler = vi.fn()
    eventBus.on('document.deleted', handler)

    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(res)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'doc-1', deleted: true })

    // The stored object is removed only after the row delete succeeded; the
    // retention backstop for linked documents is the block_document_deletion
    // DB trigger, not the storage layer.
    expect(remove).toHaveBeenCalledWith(['documents/company-1/user-1/kvitto.pdf'])

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: 'doc-1', file_name: 'kvitto.pdf' }),
        userId: 'user-1',
        companyId: 'company-1',
      }),
    )
  })

  it('returns 409 with BFL message when DB trigger blocks deletion (defense-in-depth)', async () => {
    // Caller bypasses the application-layer check (e.g. race condition).
    // The block_document_deletion() trigger raises with "Bokföringslagen" in the
    // message; the service maps it to a 409.
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: null,
        user_id: 'user-1',
      },
      error: null,
    })
    enqueue({
      data: null,
      error: { message: 'Cannot delete document linked to a posted journal entry (Bokföringslagen)' },
    })

    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toContain('Bokföringslagen')
  })
})
