import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../categories', () => ({
  countInboxDocuments: vi.fn().mockResolvedValue(6),
  countSupplierInvoicesAwaitingApproval: vi.fn().mockResolvedValue(1),
  countVerifikatMissingDocument: vi.fn().mockResolvedValue(3),
  countOverdueInvoices: vi.fn().mockResolvedValue(5),
  countDeadlinesNeedingAction: vi.fn().mockResolvedValue(1),
  countPendingOperations: vi.fn().mockResolvedValue(2),
}))

import { getWorklistCounts } from '../aggregate'

const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getWorklistCounts', () => {
  it('aggregates every category', async () => {
    const { counts } = await getWorklistCounts(supabase, 'company-1')
    expect(counts).toEqual({
      inbox_document: 6,
      supplier_invoice_approval: 1,
      verifikat_missing_document: 3,
      overdue_invoice: 5,
      deadline_action: 1,
      pending_operations: 2,
    })
  })

  it('sums every category into the total', async () => {
    const { total } = await getWorklistCounts(supabase, 'company-1')
    // 6 + 1 + 3 + 5 + 1 + 2
    expect(total).toBe(18)
  })
})
