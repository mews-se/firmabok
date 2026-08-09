/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warnRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnRecorder,
    error: vi.fn(),
    child() {
      return this
    },
  }),
}))

vi.mock('../lib/agi-client', () => ({
  agiGetKvittenser: vi.fn(),
}))

vi.mock('../lib/resolve-auth', () => ({
  resolveReadAuth: vi.fn(),
}))

vi.mock('../lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue(undefined),
}))

import { reconcileAgiDeclaration } from '../lib/agi-kvittens-reconcile'
import { agiGetKvittenser } from '../lib/agi-client'
import { resolveReadAuth } from '../lib/resolve-auth'
import { sendKvittensNotification } from '../lib/kvittens-notification'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'

const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockResolveReadAuth = vi.mocked(resolveReadAuth)
const mockSendKvittensNotification = vi.mocked(sendKvittensNotification)
const mockCompleteTaxDeadline = vi.mocked(completeTaxDeadline)

const DECL = {
  id: 'decl-1',
  company_id: 'comp-1',
  salary_run_id: 'run-1',
  period_year: 2026,
  period_month: 5,
}

/**
 * Table-aware stub covering the reconciler's four query shapes:
 * company_settings select (.single), the agi_declarations claim update
 * (awaited), the salary_runs update (awaited), and the extension_data
 * delete (awaited). Records which tables were mutated so the "no side
 * effects" assertions are structural, not inferred.
 */
function makeSupabase(opts: {
  claim?: { data?: unknown[] | null; error?: { message: string } | null }
  salaryRunError?: { message: string } | null
} = {}) {
  const mutatedTables: string[] = []
  return {
    supabase: {
      from(table: string) {
        let op: 'read' | 'mutate' = 'read'
        const chain: any = {}
        for (const method of ['select', 'eq', 'order', 'limit', 'in']) {
          chain[method] = vi.fn(() => chain)
        }
        for (const method of ['update', 'delete']) {
          chain[method] = vi.fn(() => {
            op = 'mutate'
            return chain
          })
        }
        chain.single = vi.fn(async () => ({
          data:
            table === 'company_settings'
              ? { org_number: '556123-4567', entity_type: 'aktiebolag' }
              : null,
          error: null,
        }))
        chain.then = (resolve: (v: unknown) => void) => {
          if (op === 'mutate') mutatedTables.push(table)
          if (table === 'agi_declarations' && op === 'mutate') {
            return resolve({
              data: opts.claim && 'data' in opts.claim ? opts.claim.data : [{ id: DECL.id }],
              error: opts.claim?.error ?? null,
            })
          }
          if (table === 'salary_runs') {
            return resolve({ error: opts.salaryRunError ?? null })
          }
          return resolve({ data: null, error: null })
        }
        return chain
      },
    } as any,
    mutatedTables,
  }
}

function kvittensResponse() {
  return {
    ok: true,
    status: 200,
    data: {
      kvittenser: [
        {
          uuidKvittens: 'uuid-1',
          signeradAv: '191212121212',
          signeradTid: '2026-06-01T10:00:00Z',
        },
      ],
    },
  } as any
}

describe('reconcileAgiDeclaration: claim semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveReadAuth.mockResolvedValue({
      ok: true,
      auth: { mode: 'user' } as any,
      source: 'user',
      tokenUserId: 'user-1',
    })
    mockAgiGetKvittenser.mockResolvedValue(kvittensResponse())
  })

  it('promotes the declaration and runs all side effects on a successful claim', async () => {
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mutatedTables).toEqual(['agi_declarations', 'salary_runs', 'extension_data'])
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
  })

  it('returns already_claimed and runs no side effects when another run won the claim', async () => {
    const { supabase, mutatedTables } = makeSupabase({ claim: { data: [] } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'post-connect' })

    expect(outcome).toEqual({ status: 'already_claimed' })
    // Only the claim attempt itself mutated anything.
    expect(mutatedTables).toEqual(['agi_declarations'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('returns error and runs no side effects when the claim update fails', async () => {
    const { supabase, mutatedTables } = makeSupabase({
      claim: { data: null, error: { message: 'connection reset' } },
    })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toMatchObject({ status: 'error' })
    expect((outcome as { error: string }).error).toContain('connection reset')
    expect(mutatedTables).toEqual(['agi_declarations'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('still reports signed and continues when the salary_runs stamp fails', async () => {
    const { supabase } = makeSupabase({ salaryRunError: { message: 'row locked' } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
    const warned = warnRecorder.mock.calls.map(c => String(c[0]))
    expect(warned.some(m => m.includes('agi_submitted_at stamp failed'))).toBe(true)
  })

  it('returns still_pending without attempting a claim when no kvittens exists', async () => {
    mockAgiGetKvittenser.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kvittenser: [] },
    } as any)
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'still_pending' })
    expect(mutatedTables).toEqual([])
  })
})
