import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import type { InvoiceExtractionResult } from '@/types'

ensureInitialized()

/**
 * GET /api/inbox: list document-inbox items (Underlag) for the active company.
 *
 * The inbox is a general document intake: receipts, supplier invoices, own
 * invoice copies, contracts. Nothing here assumes the extraction looks like an
 * invoice; extracted_data only decorates the row when present.
 *
 * Status model (see migration 20260504180000): the status CHECK allows
 * received | error. An item is HANDLED once any terminal link is set
 * (created_supplier_invoice_id, created_journal_entry_id,
 * matched_transaction_id, linked_journal_entry_id): the same "processed"
 * semantics the MCP server's gnubok_list_inbox_items uses.
 * linked_journal_entry_id is trigger-maintained (migration 20260809220000):
 * it follows document_attachments.journal_entry_id, so linking the item's
 * document to a verifikat through ANY path resolves the row. status='error'
 * doubles as the parked/dismissed state: nothing in this fork writes 'error'
 * anymore (the extraction pipeline was removed), so the human dismiss action
 * reuses it via PATCH /api/inbox/[id].
 *
 * Query params:
 *   status: 'pending' (default) | 'handled' | 'all'
 *   limit, offset: pagination (default 50, max 200)
 */

interface InboxRow {
  id: string
  status: string
  source: string | null
  created_at: string
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  extraction_skipped: boolean
  error_message: string | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  linked_journal_entry_id: string | null
}

interface DocRow {
  id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number
}

const INBOX_COLUMNS =
  'id, status, source, created_at, document_id, extracted_data, extraction_skipped, ' +
  'error_message, matched_supplier_id, matched_transaction_id, ' +
  'created_supplier_invoice_id, created_journal_entry_id, linked_journal_entry_id'

export const GET = withRouteContext('inbox.list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get('status') || 'pending'
  const rawLimit = parseInt(searchParams.get('limit') || '50', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
  const rawOffset = parseInt(searchParams.get('offset') || '0', 10)
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

  let query = supabase
    .from('invoice_inbox_items')
    .select(INBOX_COLUMNS, { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (statusFilter === 'pending') {
    query = query
      .eq('status', 'received')
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
      .is('matched_transaction_id', null)
      .is('linked_journal_entry_id', null)
  } else if (statusFilter === 'handled') {
    // Complement of pending: any terminal link, or parked/dismissed.
    query = query.or(
      'status.eq.error,created_supplier_invoice_id.not.is.null,' +
        'created_journal_entry_id.not.is.null,matched_transaction_id.not.is.null,' +
        'linked_journal_entry_id.not.is.null',
    )
  }

  const { data, error, count } = await query

  if (error) {
    log.error('inbox list query failed', error)
    return errorResponse(error, log, { requestId })
  }

  const rows = (data ?? []) as unknown as InboxRow[]
  const docIds = [...new Set(rows.map((r) => r.document_id).filter((id): id is string => !!id))]

  const docById = new Map<string, DocRow>()
  if (docIds.length > 0) {
    const { data: docRows, error: docError } = await supabase
      .from('document_attachments')
      .select('id, file_name, mime_type, file_size_bytes')
      .eq('company_id', companyId)
      .in('id', docIds)

    if (docError) {
      log.error('inbox list document query failed', docError)
      return errorResponse(docError, log, { requestId })
    }
    for (const d of (docRows ?? []) as DocRow[]) docById.set(d.id, d)
  }

  const items = rows.map((row) => {
    const doc = row.document_id ? (docById.get(row.document_id) ?? null) : null
    const ex = row.extracted_data
    return {
      id: row.id,
      status: row.status,
      source: row.source,
      created_at: row.created_at,
      document_id: row.document_id,
      file_name: doc?.file_name ?? null,
      mime_type: doc?.mime_type ?? null,
      file_size_bytes: doc?.file_size_bytes ?? null,
      extraction_skipped: row.extraction_skipped,
      error_message: row.error_message,
      matched_supplier_id: row.matched_supplier_id,
      matched_transaction_id: row.matched_transaction_id,
      created_supplier_invoice_id: row.created_supplier_invoice_id,
      created_journal_entry_id: row.created_journal_entry_id,
      linked_journal_entry_id: row.linked_journal_entry_id,
      // Optional extraction summary; null for documents that are not
      // invoice-shaped (contracts, letters) or not yet extracted.
      supplier_name: ex?.supplier?.name ?? null,
      amount: ex?.totals?.total ?? null,
      currency: ex?.invoice?.currency ?? null,
      invoice_date: ex?.invoice?.invoiceDate ?? null,
    }
  })

  return NextResponse.json({ data: items, count: count ?? items.length })
})
