import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
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

// Mock only the storage write; validateDocumentFile stays real so the route's
// size/type gate is exercised.
const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return {
    ...actual,
    uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
  }
})

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

function makeUploadRequest(file: File | null): Request {
  const formData = new FormData()
  if (file) formData.append('file', file)
  return new Request('http://localhost:3000/api/inbox/upload', {
    method: 'POST',
    body: formData,
  })
}

function makePdf(name = 'kvitto.pdf'): File {
  return new File(['%PDF-1.4 test'], name, { type: 'application/pdf' })
}

describe('POST /api/inbox/upload', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeUploadRequest(makePdf()))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when no file is attached', async () => {
    const res = await POST(makeUploadRequest(null))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_NO_FILE')
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('returns 400 for a disallowed file type', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const res = await POST(makeUploadRequest(file))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_UNSUPPORTED_TYPE')
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('stores the document and creates the inbox item like the MCP path', async () => {
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    enqueue({
      data: {
        id: 'inbox-1',
        status: 'received',
        source: 'upload',
        document_id: 'doc-1',
        created_at: '2026-08-09T10:00:00Z',
      },
    })

    const res = await POST(makeUploadRequest(makePdf()))
    const { status, body } = await parseJsonResponse<{
      data: { id: string; status: string; source: string; file_name: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      id: 'inbox-1',
      status: 'received',
      source: 'upload',
      file_name: 'kvitto.pdf',
    })

    // The row matches the MCP createDocumentInboxItem payload semantics.
    const insertArgs = findCall('invoice_inbox_items', 'insert')
    expect(insertArgs?.[0]).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      status: 'received',
      source: 'upload',
      document_id: 'doc-1',
      extracted_data: {},
      matched_supplier_id: null,
    })
  })

  it('returns 500 when the inbox insert fails after the upload', async () => {
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    enqueue({ data: null, error: { message: 'insert failed' } })

    const res = await POST(makeUploadRequest(makePdf()))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INBOX_ITEM_CREATE_FAILED')
  })
})
