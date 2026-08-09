import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Smoke for check_and_increment_inbox_quota (migration 20260512083644).
 *
 * Locks in:
 *   - Two atomic upsert windows (minute + day) with serializable counter increment.
 *   - Successful calls return ok=true.
 *   - Minute-cap rejection returns ok=false + scope='minute' + retry_after_sec.
 *   - Day-cap rejection returns ok=false + scope='day'.
 *   - Decrement-on-rejection: counter is rolled back when the call is denied,
 *     so a failed attempt doesn't permanently consume budget. Both minute and
 *     day rejections must roll back the minute counter; day-cap rejection
 *     must also roll back the day counter it just incremented.
 *
 * Mock-based tests can't catch a PL/pgSQL syntax error, a wrong column
 * reference, or an INSERT…ON CONFLICT predicate that targets the wrong index.
 * This test exercises the RPC against a real Postgres so a broken function
 * fails loudly at the DB layer instead of passing the unit suite and failing
 * in production.
 */

interface QuotaResult {
  ok: boolean
  scope?: 'minute' | 'day'
  retry_after_sec?: number
}

async function callQuota(
  companyId: string,
  minuteMax: number,
  dayMax: number,
): Promise<QuotaResult> {
  const res = await getPool().query<{ result: QuotaResult }>(
    `SELECT public.check_and_increment_inbox_quota($1::uuid, $2::int, $3::int) AS result`,
    [companyId, minuteMax, dayMax],
  )
  return res.rows[0]!.result
}

async function getCounters(
  companyId: string,
): Promise<{ minute: number; day: number }> {
  const res = await getPool().query<{
    window_kind: 'minute' | 'day'
    count: number
  }>(
    `SELECT window_kind, count
       FROM public.inbox_rate_counters
      WHERE company_id = $1`,
    [companyId],
  )
  let minute = 0
  let day = 0
  for (const row of res.rows) {
    if (row.window_kind === 'minute') minute = row.count
    if (row.window_kind === 'day') day = row.count
  }
  return { minute, day }
}

describe('check_and_increment_inbox_quota.pg', () => {
  it('returns ok=true and increments both windows on a successful call', async () => {
    const { companyId } = await seedCompany()

    const result = await callQuota(companyId, 30, 500)
    expect(result.ok).toBe(true)
    expect(result.scope).toBeUndefined()

    const counters = await getCounters(companyId)
    expect(counters.minute).toBe(1)
    expect(counters.day).toBe(1)
  })

  it('increments to the cap on the boundary call, then rejects the next one', async () => {
    const { companyId } = await seedCompany()
    const MINUTE_MAX = 3

    // Three successful calls take us to count=3 (exactly at the cap).
    for (let i = 0; i < MINUTE_MAX; i++) {
      const r = await callQuota(companyId, MINUTE_MAX, 1000)
      expect(r.ok).toBe(true)
    }
    expect((await getCounters(companyId)).minute).toBe(MINUTE_MAX)

    // The 4th call exceeds the cap.
    const denied = await callQuota(companyId, MINUTE_MAX, 1000)
    expect(denied.ok).toBe(false)
    expect(denied.scope).toBe('minute')
    expect(denied.retry_after_sec).toBe(60)

    // Critical: the rejected call must NOT have permanently consumed budget.
    // Counter stays at MINUTE_MAX after the rollback inside the RPC.
    expect((await getCounters(companyId)).minute).toBe(MINUTE_MAX)
  })

  it('rejects with scope=day when the minute cap is generous but the day cap is hit', async () => {
    const { companyId } = await seedCompany()
    const DAY_MAX = 2

    for (let i = 0; i < DAY_MAX; i++) {
      const r = await callQuota(companyId, 1000, DAY_MAX)
      expect(r.ok).toBe(true)
    }
    const after = await getCounters(companyId)
    expect(after.minute).toBe(DAY_MAX)
    expect(after.day).toBe(DAY_MAX)

    const denied = await callQuota(companyId, 1000, DAY_MAX)
    expect(denied.ok).toBe(false)
    expect(denied.scope).toBe('day')
    expect(denied.retry_after_sec).toBe(3600)

    // Both counters must roll back: the day cap was checked AFTER the minute
    // counter was incremented for this call, so both increments are undone.
    const final = await getCounters(companyId)
    expect(final.minute).toBe(DAY_MAX)
    expect(final.day).toBe(DAY_MAX)
  })

  it('isolates counters per company', async () => {
    const { companyId: companyA } = await seedCompany()
    const { companyId: companyB } = await seedCompany()

    await callQuota(companyA, 30, 500)
    await callQuota(companyA, 30, 500)
    await callQuota(companyB, 30, 500)

    const a = await getCounters(companyA)
    const b = await getCounters(companyB)
    expect(a.minute).toBe(2)
    expect(b.minute).toBe(1)
  })

  it('updated_at trigger fires on counter updates', async () => {
    const { companyId } = await seedCompany()

    await callQuota(companyId, 30, 500)
    const first = await getPool().query<{ updated_at: Date }>(
      `SELECT updated_at FROM public.inbox_rate_counters
        WHERE company_id = $1 AND window_kind = 'minute'`,
      [companyId],
    )

    // Trigger an UPDATE path (second call hits ON CONFLICT DO UPDATE).
    // Sleep so the timestamp delta is observable.
    await new Promise((r) => setTimeout(r, 10))
    await callQuota(companyId, 30, 500)

    const second = await getPool().query<{ updated_at: Date }>(
      `SELECT updated_at FROM public.inbox_rate_counters
        WHERE company_id = $1 AND window_kind = 'minute'`,
      [companyId],
    )

    expect(second.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      first.rows[0]!.updated_at.getTime(),
    )
  })
})
