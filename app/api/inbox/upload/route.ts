import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/inbox/upload: upload a document into the inbox (Underlag).
 *
 * multipart/form-data with a single `file` field. Accepts everything the
 * document service accepts (general intake: receipts, invoices, contracts),
 * stores the file in the WORM archive via uploadDocument, then creates the
 * invoice_inbox_items row exactly like the MCP upload path
 * (extensions/general/mcp-server createDocumentInboxItem): status 'received',
 * source 'upload', empty extracted_data, no supplier match.
 *
 * If the inbox insert fails the stored document is NOT rolled back, matching
 * the MCP path: it stays in the archive and remains reachable via the
 * unmatched-documents surfaces.
 */
export const POST = withRouteContext(
  'inbox.upload',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return errorResponseFromCode('DOC_UPLOAD_NO_FILE', log, { requestId })
    }

    const validationError = validateDocumentFile({ size: file.size, type: file.type })
    if (validationError) {
      const code = /storlek|stor|MB/i.test(validationError)
        ? 'DOC_UPLOAD_TOO_LARGE'
        : 'DOC_UPLOAD_UNSUPPORTED_TYPE'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { reason: validationError, sizeBytes: file.size, mimeType: file.type },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    let documentId: string
    try {
      const buffer = await file.arrayBuffer()
      const document = await uploadDocument(
        supabase,
        user.id,
        companyId!,
        { name: file.name, buffer, type: file.type },
        { upload_source: 'file_upload' },
      )
      documentId = document.id
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      // Magic-byte validation rejections are a client problem, not a storage
      // failure: same mapping as POST /api/documents.
      if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
        opLog.warn('inbox upload rejected by content validation', { reason: message })
        return errorResponseFromCode('DOC_UPLOAD_INVALID_CONTENT', opLog, {
          requestId,
          details: { reason: getErrorMessage(err) },
        })
      }
      opLog.error('inbox document upload failed', err as Error)
      return errorResponseFromCode('DOC_UPLOAD_STORAGE_FAILED', opLog, { requestId })
    }

    const { data: item, error: inboxError } = await supabase
      .from('invoice_inbox_items')
      .insert({
        company_id: companyId,
        user_id: user.id,
        status: 'received',
        source: 'upload',
        document_id: documentId,
        extracted_data: {},
        matched_supplier_id: null,
      })
      .select('id, status, source, document_id, created_at')
      .single()

    if (inboxError || !item) {
      opLog.error('inbox item insert failed after document upload', inboxError ?? undefined, {
        documentId,
      })
      return errorResponseFromCode('INBOX_ITEM_CREATE_FAILED', opLog, {
        requestId,
        details: { document_id: documentId },
      })
    }

    return NextResponse.json({
      data: {
        ...item,
        file_name: file.name,
        mime_type: file.type || null,
        file_size_bytes: file.size,
      },
    })
  },
  { requireWrite: true },
)
