import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceWriteItemRow } from '@/lib/invoices/build-invoice-write'

/**
 * Replace ALL invoice_items rows of a DRAFT invoice with `items` (full-replace
 * semantics: delete everything, then insert the new set with `invoice_id`
 * stamped on).
 *
 * Only valid for editable drafts: a draft has no journal entry or linked
 * documents, so delete + reinsert is safe and lets the caller add / remove /
 * reorder rows freely (invoice_items cascade nothing else). The caller is
 * responsible for the draft guard (isEditableInvoiceDraft) BEFORE calling.
 *
 * Delete + insert is not atomic over PostgREST, so the existing rows are
 * snapshotted first and best-effort restored when the insert fails: without
 * that, a rejected insert (constraint violation, transient error) left the
 * draft with ZERO items and the user's line content gone. Same
 * snapshot/restore idiom as commitUpdateRecurringSchedule in
 * lib/pending-operations/commit.ts. `restored` on the insert-failure shape
 * says whether the previous rows are back; the success path is unchanged.
 *
 * Shared by the cookie PATCH route (app/api/invoices/[id]), the v1 REST PATCH
 * route, and the update_invoice commit executor so the replace logic cannot
 * drift between the surfaces.
 */
export type ReplaceInvoiceItemsResult =
  | { ok: true }
  | { ok: false; stage: 'delete'; error: PostgrestError }
  | {
      ok: false
      stage: 'insert'
      error: PostgrestError
      /**
       * Whether the pre-delete rows were put back after the failed insert.
       * True when the restore insert succeeded (or there was nothing to
       * restore); false when the draft may have been left without items and
       * the caller should say so instead of reporting a clean failure.
       */
      restored: boolean
    }

/** Server-generated invoice_items columns that must not be re-inserted. */
const SERVER_GENERATED_COLUMNS = ['id', 'created_at', 'updated_at'] as const

export async function replaceInvoiceItems(
  supabase: SupabaseClient,
  invoiceId: string,
  items: InvoiceWriteItemRow[],
): Promise<ReplaceInvoiceItemsResult> {
  // Snapshot before deleting. select('*') on purpose: the restore must carry
  // every content column, including ones added after this function was
  // written, so an explicit list here would silently drop new fields.
  const { data: snapshotRows, error: snapshotError } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', invoiceId)

  const { error: deleteError } = await supabase
    .from('invoice_items')
    .delete()
    .eq('invoice_id', invoiceId)

  if (deleteError) return { ok: false, stage: 'delete', error: deleteError }

  const { error: insertError } = await supabase
    .from('invoice_items')
    .insert(items.map((item) => ({ ...item, invoice_id: invoiceId })))

  if (insertError) {
    // Best-effort restore of the snapshot so the draft keeps its lines. A
    // failed (or impossible) restore is reported, never swallowed.
    let restored = false
    if (snapshotError || snapshotRows == null) {
      restored = false
    } else if (snapshotRows.length === 0) {
      // Nothing existed before, so the draft is already in its prior state.
      restored = true
    } else {
      const restoreRows = (snapshotRows as Record<string, unknown>[]).map((row) => {
        const copy: Record<string, unknown> = { ...row }
        for (const column of SERVER_GENERATED_COLUMNS) delete copy[column]
        copy.invoice_id = invoiceId
        return copy
      })
      const { error: restoreError } = await supabase
        .from('invoice_items')
        .insert(restoreRows)
      restored = !restoreError
    }
    return { ok: false, stage: 'insert', error: insertError, restored }
  }

  return { ok: true }
}
