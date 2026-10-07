import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeFiscalPeriod } from '@/tests/helpers'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown; count?: number | null }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'not', 'or', 'order', 'limit', 'is', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  // Thenable for chains awaited without .single()
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  // Client has NO .then: won't be consumed by `await createClient()`
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

import {
  lockPeriod,
  unlockPeriod,
  closePeriod,
  createNextPeriod,
  findNextPeriod,
  resolvePeriodStatusForDate,
} from '../period-service'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
})

describe('lockPeriod', () => {
  it('sets locked_at and emits period.locked', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', locked_at: null, is_closed: false })
    const lockedPeriod = { ...period, locked_at: '2024-12-31T23:59:59Z' }

    results = [
      { data: period, error: null },              // fetch
      { data: lockedPeriod, error: null },         // update
    ]

    const handler = vi.fn()
    eventBus.on('period.locked', handler)

    const supabase = makeClient()
    const result = await lockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.locked_at).toBeTruthy()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects already-locked period', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-06-01T00:00:00Z',
      is_closed: false,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(lockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('already locked')
  })
})

// ============================================================
// resolvePeriodStatusForDate: the shared lock helper must fail CLOSED.
// A swallowed PostgREST error used to be reported as `open`, which every
// caller reads as "this date is writable".
// ============================================================

describe('resolvePeriodStatusForDate', () => {
  it('reports a verified open period', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status).toEqual({ period_id: 'fp-1', status: 'open', lock_date: null })
  })

  it('keeps "no covering period" distinguishable: open with a null period_id and no failure flag', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: null, error: null },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).toBe('open')
    expect(status.period_id).toBeNull()
    expect(status.lookup_failed).toBeUndefined()
  })

  it('fails closed when the company_settings lookup errors', async () => {
    results = [{ data: null, error: { message: 'PGRST301 JWT expired' } }]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).not.toBe('open')
    expect(status).toEqual({
      period_id: null,
      status: 'locked',
      lock_date: null,
      lookup_failed: true,
    })
  })

  it('fails closed when the fiscal_periods lookup errors', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      // e.g. two overlapping periods cover the date: .maybeSingle() errors.
      { data: null, error: { message: 'JSON object requested, multiple rows returned' } },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).not.toBe('open')
    expect(status.lookup_failed).toBe(true)
    expect(status.period_id).toBeNull()
  })

  it('still resolves the company lock date layer without touching the period lookup verdict', async () => {
    results = [
      { data: { bookkeeping_locked_through: '2026-06-30' }, error: null },
      // Refinement lookup fails: verdict is already locked, so this is non-fatal.
      { data: null, error: { message: 'timeout' } },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).toBe('locked')
    expect(status.lock_date).toBe('2026-06-30')
    expect(status.lookup_failed).toBeUndefined()
  })

  it('reports closed and locked periods unchanged', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-1', is_closed: true, locked_at: null }, error: null },
    ]
    await expect(
      resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01'),
    ).resolves.toEqual({ period_id: 'fp-1', status: 'closed', lock_date: null })

    resultIdx = 0
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-2', is_closed: false, locked_at: '2026-01-31T00:00:00Z' }, error: null },
    ]
    await expect(
      resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01'),
    ).resolves.toEqual({
      period_id: 'fp-2',
      status: 'locked',
      lock_date: '2026-01-31T00:00:00Z',
    })
  })
})

describe('closePeriod', () => {
  it('requires period is locked and has closing_entry_id', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
      closing_entry_id: 'ce-1',
    })
    const closedPeriod = { ...period, is_closed: true, closed_at: '2024-12-31T23:59:59Z' }

    results = [
      { data: period, error: null },
      { data: closedPeriod, error: null },
    ]

    const supabase = makeClient()
    const result = await closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.is_closed).toBe(true)
  })

  it('rejects if not locked', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: null,
      is_closed: false,
      closing_entry_id: 'ce-1',
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('must be locked')
  })

  it('rejects if no closing_entry_id', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
      closing_entry_id: null,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      'Year-end closing must be executed'
    )
  })
})

describe('unlockPeriod', () => {
  it('clears locked_at and emits period.unlocked', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
    })
    const unlocked = { ...period, locked_at: null }

    results = [
      { data: period, error: null },
      { data: unlocked, error: null },
      { data: null, error: null }, // audit_log insert
    ]

    const handler = vi.fn()
    eventBus.on('period.unlocked', handler)

    const supabase = makeClient()
    const result = await unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.locked_at).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects period that is not locked', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', locked_at: null, is_closed: false })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('not locked')
  })

  it('rejects closed period', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: true,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      'Cannot unlock a closed period'
    )
  })
})

describe('createNextPeriod', () => {
  it('calculates correct dates for standard (Jan-Dec) fiscal year', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })

    const nextPeriod = makeFiscalPeriod({
      id: 'fp-2025',
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null },      // fetch current
      { data: null, error: null },          // check if next exists (maybeSingle)
      { data: nextPeriod, error: null },    // insert
    ]

    const supabase = makeClient()
    const result = await createNextPeriod(supabase as never, 'company-1', 'user-1', 'fp-2024')
    expect(result.period_start).toBe('2025-01-01')
    expect(result.period_end).toBe('2025-12-31')
    expect(result.previous_period_id).toBe('fp-2024')
  })

  it('calculates correct dates for broken (Jul-Jun) fiscal year', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2023-07-01',
      period_end: '2024-06-30',
    })

    const nextPeriod = makeFiscalPeriod({
      id: 'fp-2025',
      name: 'FY 2024/2025',
      period_start: '2024-07-01',
      period_end: '2025-06-30',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null },
      { data: null, error: null },
      { data: nextPeriod, error: null },
    ]

    const supabase = makeClient()
    const result = await createNextPeriod(supabase as never, 'company-1', 'user-1', 'fp-2024')
    expect(result.period_start).toBe('2024-07-01')
    expect(result.period_end).toBe('2025-06-30')
  })
})

describe('findNextPeriod', () => {
  it('returns the period chained via previous_period_id', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })
    const next = makeFiscalPeriod({
      id: 'fp-2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null }, // fetch current
      { data: next, error: null },    // chained lookup (.maybeSingle)
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result?.id).toBe('fp-2025')
  })

  it('falls back to period_start lookup when chain is missing', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })
    const next = makeFiscalPeriod({
      id: 'fp-2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: null,
    })

    results = [
      { data: current, error: null }, // fetch current
      { data: null, error: null },    // chained lookup misses
      { data: next, error: null },    // date lookup hits
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result?.id).toBe('fp-2025')
  })

  it('returns null when no next period exists', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })

    results = [
      { data: current, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result).toBeNull()
  })

  it('returns null when current period not found', async () => {
    results = [{ data: null, error: { message: 'not found' } }]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'missing')
    expect(result).toBeNull()
  })

  // An SIE import had wired 2026/2027.previous_period_id
  // to 2024/2025 across a missing 2025/2026, and run_year_end seeded the
  // closing balances of 2024/2025 into 2026/2027 because the chained row was
  // returned unchecked. A non-adjacent link must be ignored so the caller
  // creates the chronologically correct next period instead.
  it('ignores a chained period that is not date-adjacent and falls back to the date lookup', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const twoYearsOut = makeFiscalPeriod({
      id: 'fp-2026-27',
      period_start: '2026-05-01',
      period_end: '2027-04-30',
      previous_period_id: 'fp-2024-25',
    })

    results = [
      { data: current, error: null },     // fetch current
      { data: twoYearsOut, error: null }, // chained lookup hits the wrong period
      { data: null, error: null },        // date lookup: 2025-05-01 does not exist
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024-25')
    expect(result).toBeNull()
  })

  it('prefers the date-adjacent period over a mis-chained one', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const twoYearsOut = makeFiscalPeriod({
      id: 'fp-2026-27',
      period_start: '2026-05-01',
      period_end: '2027-04-30',
      previous_period_id: 'fp-2024-25',
    })
    const adjacent = makeFiscalPeriod({
      id: 'fp-2025-26',
      period_start: '2025-05-01',
      period_end: '2026-04-30',
      previous_period_id: null,
    })

    results = [
      { data: current, error: null },
      { data: twoYearsOut, error: null },
      { data: adjacent, error: null },
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024-25')
    expect(result?.id).toBe('fp-2025-26')
  })
})

describe('createNextPeriod chain healing', () => {
  it('relinks a successor that was chained across the gap onto the new period', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const created = makeFiscalPeriod({
      id: 'fp-2025-26',
      period_start: '2025-05-01',
      period_end: '2026-04-30',
      previous_period_id: 'fp-2024-25',
    })

    results = [
      { data: current, error: null },            // fetch current
      { data: [], error: null },                  // overlap check
      { data: created, error: null },             // insert
      { data: [{ id: 'fp-2026-27' }], error: null }, // mis-chained successor starting 2026-05-01
      { data: null, error: null },                // relink update
    ]

    const client = makeClient()
    const builders: Array<Record<string, unknown>> = []
    const from = client.from
    client.from = vi.fn().mockImplementation(() => {
      const b = from()
      builders.push(b)
      return b
    })

    const result = await createNextPeriod(client as never, 'company-1', 'user-1', 'fp-2024-25')
    expect(result.id).toBe('fp-2025-26')

    const relink = builders.find((b) => (b.update as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(relink).toBeDefined()
    expect((relink!.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ previous_period_id: 'fp-2025-26' })
    expect((relink!.in as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['id', ['fp-2026-27']])
  })
})
