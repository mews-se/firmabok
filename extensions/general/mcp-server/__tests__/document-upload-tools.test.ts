import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocumentAttachment } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'

const mocks = vi.hoisted(() => ({
  createPendingDocumentUpload: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return {
    ...actual,
    createPendingDocumentUpload: mocks.createPendingDocumentUpload,
    completePendingDocumentUpload: mocks.completePendingDocumentUpload,
  }
})

import { tools } from '../server'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const uploadId = '33333333-3333-4333-8333-333333333333'

function findTool(name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'limit', 'insert']) {
    builder[method] = vi.fn().mockReturnValue(builder)
  }
  builder.maybeSingle = vi.fn().mockResolvedValue(result)
  builder.single = vi.fn().mockResolvedValue(result)
  return builder
}

describe('MCP model-free document upload tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl: 'https://storage.example/upload?token=signed',
      expiresAt: '2026-08-03T12:00:00.000Z',
    })
    mocks.completePendingDocumentUpload.mockResolvedValue({
      document: makeDocumentAttachment({
        id: uploadId,
        user_id: userId,
        company_id: companyId,
        file_name: 'invoice.pdf',
        mime_type: 'application/pdf',
      }),
      buffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer,
    })
  })

  it('returns an unauthenticated PUT URL without accepting file bytes', async () => {
    const tool = findTool('gnubok_create_document_upload')
    const result = await tool.execute(
      { file_name: 'invoice.pdf' },
      companyId,
      userId,
      {} as never,
    )

    expect(mocks.createPendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'invoice.pdf',
    )
    expect(result).toEqual({
      upload_id: uploadId,
      upload_url: 'https://storage.example/upload?token=signed',
      expires_at: '2026-08-03T12:00:00.000Z',
    })
    const schema = tool.inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties).not.toHaveProperty('file_content_base64')
  })

  it('completes the reserved upload and uses the upload UUID for both records', async () => {
    const inboxInsert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      inboxInsert,
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )

    expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      uploadId,
      'invoice.pdf',
      'application/pdf',
    )
    expect(inboxInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadId, document_id: uploadId }),
    )
    expect(result).toMatchObject({
      document_id: uploadId,
      inbox_item_id: uploadId,
      status: 'received',
    })
  })

  it('returns an already completed inbox item without downloading again', async () => {
    const existing = makeQueryBuilder({
      data: {
        id: uploadId,
        document_id: uploadId,
        status: 'received',
        extracted_data: { invoice: { number: 'INV-1' } },
        matched_supplier_id: null,
      },
      error: null,
    })
    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from: vi.fn().mockReturnValue(existing) } as never,
    )

    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
    expect(mocks.completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('keeps the upload paths on the transactions:write scope and free of capability gates', () => {
    for (const name of [
      'gnubok_create_document_upload',
      'gnubok_complete_document_upload',
      'gnubok_upload_document',
    ]) {
      expect(TOOL_SCOPE_MAP[name]).toBe('transactions:write')
      expect(MCP_TOOL_CAPABILITY_MAP[name]).toBeUndefined()
    }
  })
})
