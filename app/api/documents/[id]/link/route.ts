import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { LinkDocumentSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * POST /api/documents/[id]/link: link a document to a journal entry.
 *
 * Body: { journal_entry_id: string, journal_entry_line_id?: string }
 *
 * The inbox side needs no work here: the sync trigger on
 * document_attachments.journal_entry_id (migration 20260809220000) stamps
 * invoice_inbox_items.linked_journal_entry_id atomically with the link, so
 * the owning inbox item drops out of the active inbox regardless of which
 * caller performed the link. (The route used to stamp
 * created_journal_entry_id itself when the client passed inbox_item_id, but
 * that pointer is UNIQUE for the book-direct race guard and rejected the
 * second document linked to the same verifikat.)
 */
export const POST = withRouteContext(
  'document.link',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ documentId: id })

    const parsed = LinkDocumentSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            reason: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    try {
      const document = await linkToJournalEntry(
        supabase,
        companyId!,
        id,
        body.journal_entry_id,
        body.journal_entry_line_id,
      )

      return NextResponse.json({ data: document })
    } catch (err) {
      opLog.error('document link failed', err as Error, {
        journalEntryId: body.journal_entry_id,
      })
      const message = err instanceof Error ? err.message : ''
      // Linking writes journal_entry_id on document_attachments; the
      // enforce_period_lock trigger blocks that when the target entry sits in a
      // closed/locked period.
      if (/locked\/closed fiscal period|Bokföringen är låst/i.test(message)) {
        return errorResponseFromCode('PERIOD_LOCKED', opLog, { requestId })
      }
      if (/journal entry not found/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ENTRY_NOT_FOUND', opLog, { requestId })
      }
      if (/already linked/i.test(message)) {
        return errorResponseFromCode('DOC_LINK_ALREADY_LINKED', opLog, { requestId })
      }
      return errorResponseFromCode('DOC_LINK_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(err) },
      })
    }
  },
  { requireWrite: true },
)
