import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorklistCounts } from './types'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countSupplierInvoicesAwaitingApproval,
  countVerifikatMissingDocument,
} from './categories'

/**
 * All worklist counts in one round-trip burst. Each count is a bounded query
 * (mostly head-only) and individually soft-fails to 0, so this is safe to call
 * from layouts and server components on every render.
 */
export async function getWorklistCounts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<WorklistCounts> {
  const [
    inboxDocument,
    supplierInvoiceApproval,
    verifikatMissingDocument,
    overdueInvoice,
    deadlineAction,
    pendingOperations,
  ] = await Promise.all([
    countInboxDocuments(supabase, companyId),
    countSupplierInvoicesAwaitingApproval(supabase, companyId),
    countVerifikatMissingDocument(supabase, companyId),
    countOverdueInvoices(supabase, companyId),
    countDeadlinesNeedingAction(supabase, companyId),
    countPendingOperations(supabase, companyId),
  ])

  return {
    counts: {
      inbox_document: inboxDocument,
      supplier_invoice_approval: supplierInvoiceApproval,
      verifikat_missing_document: verifikatMissingDocument,
      overdue_invoice: overdueInvoice,
      deadline_action: deadlineAction,
      pending_operations: pendingOperations,
    },
    total:
      inboxDocument +
      supplierInvoiceApproval +
      verifikatMissingDocument +
      overdueInvoice +
      deadlineAction +
      pendingOperations,
  }
}
