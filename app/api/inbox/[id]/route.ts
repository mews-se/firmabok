import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { InboxItemActionSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deleteDocument } from '@/lib/core/documents/document-service'

ensureInitialized()

/**
 * GET /api/inbox/[id]: one document-inbox item, with its document metadata.
 * Serves the supplier-invoice form's prefill (extracted_data,
 * matched_supplier_id, document_id) among others.
 *
 * PATCH /api/inbox/[id]: { action: 'dismiss' | 'restore' }.
 * The status CHECK (migration 20260504180000) allows received | error, and
 * nothing in this fork writes 'error' anymore (the extraction pipeline is
 * gone), so 'error' doubles as the parked/dismissed state:
 *   dismiss: received -> error (refused once a terminal link exists)
 *   restore: error -> received
 * Status is the only column written: error_message is left as-is so a legacy
 * failure note survives a dismiss/restore round trip.
 */

interface InboxItemRow {
  id: string
  status: string
  source: string | null
  created_at: string
  document_id: string | null
  extracted_data: Record<string, unknown> | null
  extraction_skipped: boolean
  error_message: string | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  channel_context: Record<string, unknown> | null
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inbox.get',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select(
        'id, status, source, created_at, document_id, extracted_data, extraction_skipped, ' +
          'error_message, matched_supplier_id, matched_transaction_id, ' +
          'created_supplier_invoice_id, created_journal_entry_id, channel_context',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    const item = data as unknown as InboxItemRow | null

    if (error) {
      log.error('inbox item fetch failed', error)
      return errorResponse(error, log, { requestId })
    }
    if (!item) {
      return errorResponseFromCode('INBOX_ITEM_NOT_FOUND', log, { requestId })
    }

    let document: {
      id: string
      file_name: string
      mime_type: string | null
      file_size_bytes: number
    } | null = null
    if (item.document_id) {
      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, file_name, mime_type, file_size_bytes')
        .eq('id', item.document_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (docError) {
        log.error('inbox item document fetch failed', docError)
        return errorResponse(docError, log, { requestId })
      }
      document = doc ?? null
    }

    return NextResponse.json({ data: { ...item, document } })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inbox.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, InboxItemActionSchema, {
      log,
      operation: 'inbox.update',
    })
    if (!validation.success) return validation.response
    const { action } = validation.data

    const { data: item, error } = await supabase
      .from('invoice_inbox_items')
      .select(
        'id, status, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      log.error('inbox item fetch failed', error)
      return errorResponse(error, log, { requestId })
    }
    if (!item) {
      return errorResponseFromCode('INBOX_ITEM_NOT_FOUND', log, { requestId })
    }

    const handled = !!(
      item.created_supplier_invoice_id ||
      item.created_journal_entry_id ||
      item.matched_transaction_id
    )
    if (action === 'dismiss' && handled) {
      return errorResponseFromCode('INBOX_ITEM_ALREADY_HANDLED', log, {
        requestId,
        details: {
          created_supplier_invoice_id: item.created_supplier_invoice_id,
          created_journal_entry_id: item.created_journal_entry_id,
          matched_transaction_id: item.matched_transaction_id,
        },
      })
    }

    const nextStatus = action === 'dismiss' ? 'error' : 'received'
    if (item.status === nextStatus) {
      // Idempotent: dismissing a dismissed item (or restoring an active one)
      // is a no-op success, not a conflict.
      return NextResponse.json({ data: { id: item.id, status: item.status } })
    }

    const { data: updated, error: updateError } = await supabase
      .from('invoice_inbox_items')
      .update({ status: nextStatus })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, status')
      .single()

    if (updateError || !updated) {
      log.error('inbox item status update failed', updateError ?? undefined)
      return errorResponse(updateError ?? new Error('update failed'), log, { requestId })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/inbox/[id]: permanently remove an inbox item together with its
 * document. Only for items that never became bookkeeping: a terminal-linked
 * item refuses here, and a document attached to a verifikat refuses inside
 * deleteDocument (räkenskapsinformation, BFL 7 kap 2 §). The document goes
 * first so a refusal leaves the item intact and visible.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inbox.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { data: item, error } = await supabase
      .from('invoice_inbox_items')
      .select(
        'id, document_id, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      log.error('inbox item fetch failed', error)
      return errorResponse(error, log, { requestId })
    }
    if (!item) {
      return errorResponseFromCode('INBOX_ITEM_NOT_FOUND', log, { requestId })
    }

    const handled = !!(
      item.created_supplier_invoice_id ||
      item.created_journal_entry_id ||
      item.matched_transaction_id
    )
    if (handled) {
      return errorResponseFromCode('INBOX_ITEM_ALREADY_HANDLED', log, {
        requestId,
        details: {
          created_supplier_invoice_id: item.created_supplier_invoice_id,
          created_journal_entry_id: item.created_journal_entry_id,
          matched_transaction_id: item.matched_transaction_id,
        },
      })
    }

    if (item.document_id) {
      const result = await deleteDocument(supabase, companyId, item.document_id)
      if (!result.ok && result.reason !== 'not_found') {
        return NextResponse.json({ error: result.message }, { status: result.status })
      }
    }

    const { error: deleteError } = await supabase
      .from('invoice_inbox_items')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (deleteError) {
      log.error('inbox item delete failed', deleteError)
      return errorResponse(deleteError, log, { requestId })
    }

    return NextResponse.json({ data: { id: item.id, deleted: true } })
  },
  { requireWrite: true },
)
