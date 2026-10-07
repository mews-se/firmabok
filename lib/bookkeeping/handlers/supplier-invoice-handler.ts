import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createClient } from '@/lib/supabase/server'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { createLogger } from '@/lib/logger'
import type { SupplierInvoiceItem } from '@/types'

const log = createLogger('supplier-invoice-handler')

/**
 * Core event handler: creates a registration journal entry when a supplier
 * invoice is confirmed (accrual method only).
 *
 * This decouples journal entry creation from the invoice-inbox extension,
 * making it a core concern triggered by the `supplier_invoice.confirmed` event.
 */
async function handleSupplierInvoiceConfirmed(
  payload: EventPayload<'supplier_invoice.confirmed'>
): Promise<void> {
  const { supplierInvoice, userId, companyId } = payload

  // Guard: the inbox convert flow (and app/api/supplier-invoices) creates the
  // registration entry inline before emitting. Without this short-circuit we
  // double-post to 2440/2641/expense and overwrite registration_journal_entry_id.
  if (supplierInvoice.registration_journal_entry_id) return

  const supabase = await createClient()

  // Re-fetch to catch callers whose in-memory payload is stale (invoice-inbox
  // updates the row after insert but emits the pre-update object).
  const { data: current } = await supabase
    .from('supplier_invoices')
    .select('registration_journal_entry_id')
    .eq('id', supplierInvoice.id)
    .single()

  if (current?.registration_journal_entry_id) return

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  if (accountingMethod !== 'accrual') return

  // Fetch invoice items
  const { data: items, error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .select('*')
    .eq('supplier_invoice_id', supplierInvoice.id)
    .order('sort_order')

  if (itemsError || !items || items.length === 0) {
    log.error('Failed to fetch invoice items:', itemsError)
    return
  }

  // Fetch supplier type
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('supplier_type')
    .eq('id', supplierInvoice.supplier_id)
    .single()

  const supplierType = supplier?.supplier_type || 'swedish_business'

  try {
    const journalEntry = await createSupplierInvoiceRegistrationEntry(
      supabase,
      companyId,
      userId,
      supplierInvoice,
      items as SupplierInvoiceItem[],
      supplierType
    )

    if (journalEntry) {
      await supabase
        .from('supplier_invoices')
        .update({ registration_journal_entry_id: journalEntry.id })
        .eq('id', supplierInvoice.id)

      // Lines with a periodisering period get their schedule + catch-up
      // dissolutions. Idempotent per line, so a replayed event is safe.
      const scheduleResult = await createSchedulesForSupplierInvoice(
        supabase,
        companyId,
        userId,
        supplierInvoice,
        items as SupplierInvoiceItem[],
        journalEntry.id,
      )
      if (scheduleResult.failed > 0) {
        log.error('accrual schedule creation failed for confirmed supplier invoice', {
          supplierInvoiceId: supplierInvoice.id,
          failed: scheduleResult.failed,
        })
      }
    }
  } catch (err) {
    log.error('Failed to create registration journal entry:', err)
  }
}

/**
 * Register the core supplier invoice handlers on the event bus.
 * Returns a combined unsubscribe function.
 */
export function registerSupplierInvoiceHandler(): () => void {
  const unsubscribers = [
    eventBus.on('supplier_invoice.confirmed', handleSupplierInvoiceConfirmed),
  ]
  return () => unsubscribers.forEach((unsub) => unsub())
}
