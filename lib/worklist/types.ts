/**
 * Worklist: the unified "Att göra" pending-work model.
 *
 * One source of truth for what the user still has to do, shared by the
 * dashboard "Att göra" section, the sidebar badges, and (eventually) the
 * MCP list tools. Every surface that shows a pending-work count MUST read
 * it from lib/worklist so the numbers can never diverge.
 *
 * Each category documents its "done" condition: the status field or link
 * whose write makes an item drop out of the count, everywhere, at once.
 */

export const WORKLIST_CATEGORIES = [
  /**
   * Unconsumed documents in the inbox ("N st underlag att hantera").
   * Pending:  invoice_inbox_items with a document and no
   *           created_supplier_invoice_id / created_journal_entry_id /
   *           matched_transaction_id, whose document is still unlinked.
   * Done:     any of those three columns gets stamped (book-direct,
   *           supplier-invoice conversion) or the document is linked to a
   *           journal entry. Mirrors /api/documents/inbox-available.
   */
  'inbox_document',
  /**
   * Supplier invoices awaiting approval ("attestera").
   * Pending:  supplier_invoices.status = 'registered'.
   * Done:     status moves to approved/paid/credited/….
   */
  'supplier_invoice_approval',
  /**
   * Posted verifikat without underlag (BFL 5 kap 7§ documentation gap).
   * Pending:  posted journal_entries of document-requiring source types with
   *           no current-version document_attachments row and no
   *           journal_entry_no_doc_required exemption.
   * Done:     a document is linked or an exemption is recorded.
   */
  'verifikat_missing_document',
  /**
   * Overdue customer invoices ("förfallna kundfakturor").
   * Pending:  invoices.status = 'overdue', not credited.
   * Done:     paid/credited (status leaves 'overdue').
   */
  'overdue_invoice',
  /**
   * Tax/VAT deadlines needing attention.
   * Pending:  deadlines.is_completed = false AND status IN
   *           ('action_needed', 'overdue').
   * Done:     submitted/confirmed (is_completed or status transition).
   */
  'deadline_action',
  /**
   * Agent-staged operations awaiting review ("Granskning").
   * Pending:  pending_operations.status = 'pending'.
   * Done:     committed or rejected.
   */
  'pending_operations',
] as const

export type WorklistCategory = (typeof WORKLIST_CATEGORIES)[number]

export interface WorklistCounts {
  counts: Record<WorklistCategory, number>
  /** Distinct actionable items. */
  total: number
}
