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
 * Body: { journal_entry_id: string, journal_entry_line_id?: string, transaction_id?: string }
 *
 * The inbox side needs no work here: the sync trigger on
 * document_attachments.journal_entry_id (migration 20260809220000) stamps
 * invoice_inbox_items.linked_journal_entry_id atomically with the link, so
 * the owning inbox item drops out of the active inbox regardless of which
 * caller performed the link. (The route used to stamp
 * created_journal_entry_id itself when the client passed inbox_item_id, but
 * that pointer is UNIQUE for the book-direct race guard and rejected the
 * second document linked to the same verifikat.)
 *
 * When `transaction_id` is supplied (booking-flow callers that link underlag
 * right after booking a bank transaction), the doc is also pinned to the
 * transaction row (transactions.document_id) so the /transactions list shows
 * the underlag indicator. Only set when the tx has no pin yet: first linked
 * doc wins, and an existing räkenskapsinformation pin is never swapped (which
 * would trip the immutability trigger). Best-effort: a pin failure is logged
 * but does not fail the request (the doc link is the legally-relevant write).
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

      if (body.transaction_id) {
        const { error: pinError } = await supabase
          .from('transactions')
          .update({ document_id: id })
          .eq('id', body.transaction_id)
          .eq('company_id', companyId!)
          // Never swap an existing pin: keeps "first linked doc wins" semantics
          // for multi-doc bookings and avoids the BFL immutability trigger.
          .is('document_id', null)
        if (pinError) {
          // Non-fatal: the verifikat ↔ underlag link already succeeded; the
          // pin is row-level UX on the /transactions list.
          opLog.warn('transaction pin after link failed', {
            transactionId: body.transaction_id,
            reason: getUserErrorMessage(pinError),
          })
        }
      }

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
