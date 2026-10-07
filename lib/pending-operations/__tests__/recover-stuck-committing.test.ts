/**
 * Unit tests for the stuck-'committing' recovery sweep (issue #843).
 *
 * The transition legality against real triggers is covered by
 * tests/pg/pending-operations-committing-recovery.pg.test.ts; these tests pin
 * the decision logic: row selection filters, per-type evidence probes, the
 * conservative rejected-by-default outcome, CAS guards, and the metric-style
 * pending_op_recovery log line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  STUCK_COMMITTING_THRESHOLD_MINUTES,
  buildRecoveryUpdate,
  findPostedEvidence,
  recoverStuckCommittingOperations,
  type StuckCommittingRow,
} from '../recover-stuck-committing'
import type { Logger } from '@/lib/logger'

interface FilterCall {
  method: string
  args: unknown[]
}

interface QueryCapture {
  kind: 'from' | 'rpc'
  target: string
  rpcArgs?: unknown
  payload?: Record<string, unknown>
  filters: FilterCall[]
}

function createCapturingSupabase() {
  const captures: QueryCapture[] = []
  const results: Array<{ data: unknown; error: unknown }> = []

  const buildChain = (capture: QueryCapture) => {
    const result = results.shift() ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        if (method === 'update') {
          capture.payload = args[0] as Record<string, unknown>
        } else {
          capture.filters.push({ method, args })
        }
        return chain
      }
    for (const method of ['select', 'update', 'eq', 'lt', 'order', 'range', 'maybeSingle']) {
      chain[method] = vi.fn(record(method))
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  }

  const supabase = {
    from: vi.fn((table: string) => {
      const capture: QueryCapture = { kind: 'from', target: table, filters: [] }
      captures.push(capture)
      return buildChain(capture)
    }),
    rpc: vi.fn((name: string, args: unknown) => {
      const capture: QueryCapture = { kind: 'rpc', target: name, rpcArgs: args, filters: [] }
      captures.push(capture)
      return buildChain(capture)
    }),
  } as unknown as SupabaseClient

  return {
    supabase,
    captures,
    enqueue(result: { data?: unknown; error?: unknown }) {
      results.push({ data: result.data ?? null, error: result.error ?? null })
    },
  }
}

function createLogSpy(): { log: Logger; calls: Array<{ level: string; args: unknown[] }> } {
  const calls: Array<{ level: string; args: unknown[] }> = []
  const log = {
    info: vi.fn((...args: unknown[]) => calls.push({ level: 'info', args })),
    warn: vi.fn((...args: unknown[]) => calls.push({ level: 'warn', args })),
    error: vi.fn((...args: unknown[]) => calls.push({ level: 'error', args })),
    child: vi.fn(),
  } as unknown as Logger
  return { log, calls }
}

function makeRow(overrides: Partial<StuckCommittingRow> = {}): StuckCommittingRow {
  return {
    id: 'op-1',
    company_id: 'company-1',
    operation_type: 'create_customer',
    params: {},
    updated_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildRecoveryUpdate', () => {
  it('finalizes to committed with the recovered marker when evidence exists', () => {
    const row = makeRow()
    const update = buildRecoveryUpdate(row, 'target_state_observed', '2026-07-22T02:30:00.000Z')

    expect(update.status).toBe('committed')
    expect(update.resolved_at).toBe('2026-07-22T02:30:00.000Z')
    expect(update.result_data.recovered).toBe(true)
    expect(update.result_data.recovery).toMatchObject({
      reason: 'stuck_committing',
      evidence: 'target_state_observed',
      stuck_since: row.updated_at,
      swept_at: '2026-07-22T02:30:00.000Z',
    })
  })

  it('rejects with an explanation when no evidence exists, never back to pending', () => {
    const row = makeRow()
    const update = buildRecoveryUpdate(row, null, '2026-07-22T02:30:00.000Z')

    expect(update.status).toBe('rejected')
    expect(update.result_data.auto_rejected).toBe(true)
    // Distinct from 'expired' so the UI's "Utgick automatiskt" badge (strict
    // on reason === 'expired') never claims recovery rows.
    expect(update.result_data.reason).toBe('stuck_committing')
    expect(update.result_data.recovery).toMatchObject({
      evidence: null,
      stuck_since: row.updated_at,
    })
    expect((update.result_data.recovery as { note: string }).note).toMatch(/re-staging/)
  })
})

describe('findPostedEvidence', () => {
  it('returns null without touching the database: no operation type has a probe', async () => {
    const { supabase, captures } = createCapturingSupabase()

    for (const operationType of ['create_customer', 'mark_invoice_sent', 'lock_period', 'create_voucher']) {
      const evidence = await findPostedEvidence(
        supabase,
        makeRow({ operation_type: operationType, params: { invoice_id: 'inv-1' } }),
      )
      expect(evidence).toBeNull()
    }
    expect(captures).toHaveLength(0)
  })
})

describe('recoverStuckCommittingOperations', () => {
  it('lists committing rows older than the threshold and drives them terminal with a CAS', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    const { log, calls } = createLogSpy()
    const now = new Date('2026-07-22T02:30:00.000Z')

    const customerOp = makeRow({ id: 'op-customer', operation_type: 'create_customer' })
    const lockOp = makeRow({ id: 'op-lock', operation_type: 'lock_period' })

    enqueue({ data: [customerOp, lockOp] }) // listing page
    enqueue({ data: { id: 'op-customer' } }) // CAS finalize rejected
    enqueue({ data: { id: 'op-lock' } }) // CAS finalize rejected

    const summary = await recoverStuckCommittingOperations(supabase, { log, now })

    expect(summary).toEqual({ scanned: 2, committed: 0, rejected: 2, skipped: 0 })

    // Listing: status CAS filter + threshold on updated_at (the claim
    // timestamp, bumped by the updated_at trigger on the pending->committing
    // CAS) + stable order for fetchAllRows pagination.
    const listing = captures[0]
    expect(listing.target).toBe('pending_operations')
    expect(listing.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['status', 'committing'] },
        {
          method: 'lt',
          args: [
            'updated_at',
            new Date(
              now.getTime() - STUCK_COMMITTING_THRESHOLD_MINUTES * 60_000,
            ).toISOString(),
          ],
        },
      ]),
    )
    expect(listing.filters.some((f) => f.method === 'order')).toBe(true)

    // No-evidence finalize: terminal rejected, CAS-guarded on
    // status='committing', never back to pending.
    const rejectedWrite = captures[1]
    expect(rejectedWrite.payload).toMatchObject({ status: 'rejected' })
    expect((rejectedWrite.payload!.result_data as Record<string, unknown>).auto_rejected).toBe(true)
    expect(rejectedWrite.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', 'op-customer'] },
        { method: 'eq', args: ['status', 'committing'] },
      ]),
    )

    // Metric-style log line per recovered row.
    const recoveryLines = calls.filter((c) => c.args[0] === 'pending_op_recovery')
    expect(recoveryLines).toHaveLength(2)
    const outcomes = recoveryLines.map(
      (c) => (c.args[1] as Record<string, unknown>).outcome,
    )
    expect(outcomes).toEqual(['rejected', 'rejected'])
    expect(recoveryLines[0].args[1]).toMatchObject({
      pendingOperationId: 'op-customer',
      companyId: 'company-1',
      operationType: 'create_customer',
      evidence: null,
    })
  })

  it('counts a lost CAS as skipped when a concurrent finalize resolved the row first', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    const { log, calls } = createLogSpy()

    enqueue({ data: [makeRow({ id: 'op-raced' })] })
    enqueue({ data: null }) // CAS matched zero rows

    const summary = await recoverStuckCommittingOperations(supabase, { log })

    expect(summary).toEqual({ scanned: 1, committed: 0, rejected: 0, skipped: 1 })
    const line = calls.find((c) => c.args[0] === 'pending_op_recovery')
    expect((line?.args[1] as Record<string, unknown>).outcome).toBe('lost_cas')
  })

  it('returns an empty summary when nothing is stuck', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    const { log } = createLogSpy()

    enqueue({ data: [] })

    const summary = await recoverStuckCommittingOperations(supabase, { log })

    expect(summary).toEqual({ scanned: 0, committed: 0, rejected: 0, skipped: 0 })
  })
})
