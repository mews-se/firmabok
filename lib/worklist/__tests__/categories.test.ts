import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countSupplierInvoicesAwaitingApproval,
  countVerifikatMissingDocument,
} from '../categories'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('countInboxDocuments', () => {
  it('counts only items whose document is still unlinked', async () => {
    enqueue({
      data: [
        { id: 'i1', document_id: 'd1' },
        { id: 'i2', document_id: 'd2' },
        { id: 'i3', document_id: 'd3' },
      ],
    })
    enqueue({ count: 2 }) // one of the three docs is already linked elsewhere
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(2)
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('returns 0 without a document query when no unconsumed items exist', async () => {
    enqueue({ data: [] })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('chunks the document id filter so large inboxes stay under URL limits', async () => {
    // 200 deduped ids → two .in() chunks of 150 + 50, counts summed.
    enqueue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `item-${i}`,
        document_id: `doc-${i}`,
      })),
    })
    enqueue({ count: 140 })
    enqueue({ count: 45 })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(185)
    // 1 inbox query + 2 chunked document queries.
    expect(mockSupabase.from).toHaveBeenCalledTimes(3)
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countVerifikatMissingDocument', () => {
  // Predicate semantics (needs-doc source types, current versions, waivers)
  // now live in the verifikat_without_documents RPC and are pinned by
  // tests/pg/document-surfaces-unification.pg.test.ts against real Postgres.
  // These tests cover only the delegation contract.
  it('delegates to the verifikat_without_documents RPC and returns its total', async () => {
    enqueue({ data: { ok: true, total_count: 3, verifikat: [] }, error: null })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('verifikat_without_documents', {
      p_company_id: COMPANY,
      p_limit: 1,
      p_offset: 0,
    })
  })

  it('soft-fails to 0 when the RPC errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })

  it('soft-fails to 0 on a not-ok envelope (tenant guard)', async () => {
    enqueue({ data: { ok: false, code: 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN' }, error: null })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('simple head counts', () => {
  it.each([
    ['countSupplierInvoicesAwaitingApproval', countSupplierInvoicesAwaitingApproval, 'supplier_invoices'],
    ['countOverdueInvoices', countOverdueInvoices, 'invoices'],
    ['countDeadlinesNeedingAction', countDeadlinesNeedingAction, 'deadlines'],
    ['countPendingOperations', countPendingOperations, 'pending_operations'],
  ] as const)('%s returns the count and targets the right table', async (_name, fn, table) => {
    enqueue({ count: 3 })
    await expect(fn(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.from).toHaveBeenCalledWith(table)
  })
})
