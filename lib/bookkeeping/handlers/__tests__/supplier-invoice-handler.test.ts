import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  createQueuedMockSupabase,
  makeSupplierInvoice,
} from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { registerSupplierInvoiceHandler } from '../supplier-invoice-handler'

const mockCreateClient = vi.mocked(createClient)
const mockCreateEntry = vi.mocked(createSupplierInvoiceRegistrationEntry)

describe('Supplier Invoice Core Handler', () => {
  let unsubscribe: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    unsubscribe = registerSupplierInvoiceHandler()
  })

  afterEach(() => {
    unsubscribe()
  })

  it('creates registration journal entry for accrual method', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      // 1. supplier_invoices (re-fetch guard)
      { data: { registration_journal_entry_id: null }, error: null },
      // 2. company_settings
      { data: { accounting_method: 'accrual' }, error: null },
      // 3. supplier_invoice_items
      { data: [{ id: 'item-1', account_number: '6200', line_total: 1000, sort_order: 0 }], error: null },
      // 4. supplier (type)
      { data: { supplier_type: 'swedish_business' }, error: null },
      // 5. Update invoice with journal entry id
      { data: null, error: null },
    ])
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateEntry.mockResolvedValue({ id: 'je-1' } as never)

    const invoice = makeSupplierInvoice({ id: 'si-1', supplier_id: 'sup-1' })

    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-1' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockCreateEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      invoice,
      expect.any(Array),
      'swedish_business'
    )
  })

  it('skips journal entry for cash method', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      // supplier_invoices (re-fetch guard)
      { data: { registration_journal_entry_id: null }, error: null },
      // company_settings with cash method
      { data: { accounting_method: 'cash' }, error: null },
    ])
    mockCreateClient.mockResolvedValue(supabase as never)

    const invoice = makeSupplierInvoice({ id: 'si-2' })

    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-2' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockCreateEntry).not.toHaveBeenCalled()
  })

  it('handles journal entry creation failure gracefully', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { registration_journal_entry_id: null }, error: null },
      { data: { accounting_method: 'accrual' }, error: null },
      { data: [{ id: 'item-1', account_number: '6200', line_total: 500, sort_order: 0 }], error: null },
      { data: { supplier_type: 'swedish_business' }, error: null },
    ])
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateEntry.mockRejectedValue(new Error('No fiscal period'))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const invoice = makeSupplierInvoice({ id: 'si-3' })

    // Should not throw
    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-3' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    // Logger emits a structured error line; assert the handler logged the
    // failure with the right module prefix and an Error somewhere in the args.
    const calls = consoleSpy.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((c) => String(c[0]).includes('[supplier-invoice-handler]'))).toBe(true)
    expect(
      calls.some((c) =>
        c.some(
          (arg) =>
            arg instanceof Error ||
            (typeof arg === 'object' &&
              arg !== null &&
              (arg as { message?: unknown }).message === 'No fiscal period'),
        ),
      ),
    ).toBe(true)

    consoleSpy.mockRestore()
  })

  it('skips creation when payload.supplierInvoice.registration_journal_entry_id is already set', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockCreateClient.mockResolvedValue(supabase as never)

    const invoice = makeSupplierInvoice({
      id: 'si-4',
      registration_journal_entry_id: 'je-existing',
    })

    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-4' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockCreateEntry).not.toHaveBeenCalled()
    // No DB calls should have been made either (payload guard is pre-DB)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('skips creation when db row already has registration_journal_entry_id (stale payload)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      // supplier_invoices re-fetch returns an already-linked entry
      { data: { registration_journal_entry_id: 'je-db' }, error: null },
    ])
    mockCreateClient.mockResolvedValue(supabase as never)

    const invoice = makeSupplierInvoice({ id: 'si-5', registration_journal_entry_id: null })

    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-5' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockCreateEntry).not.toHaveBeenCalled()
  })
})
