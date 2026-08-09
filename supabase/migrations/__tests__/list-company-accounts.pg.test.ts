import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Locks the behavior of public.list_company_accounts (20260723170000): the
 * single-round-trip replacement for the paged fetchAllRows chart-of-accounts
 * fetch in app/api/bookkeeping/accounts.
 *
 * The route treats the RPC result as a drop-in for select('*') ordered by
 * sort_order, so the critical properties are:
 *   - filter parity: p_active_only / p_account_class mirror the route's
 *     .eq('is_active', true) / .eq('account_class', n) filters
 *   - ordering: (sort_order, id); id only breaks ties deterministically
 *   - field-set parity: every element carries the exact column set of
 *     chart_of_accounts (to_json of the whole row), so response shapes
 *     do not change when the route switches paths
 *   - SECURITY INVOKER: RLS still gates rows for non-members
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260723170000_list_company_accounts_rpc.sql'),
  'utf8',
)

interface AccountJson {
  id: string
  account_number: string
  account_class: number
  sort_order: number
  is_active: boolean
  [key: string]: unknown
}

async function callRpc(
  companyId: string,
  activeOnly: boolean = true,
  accountClass: number | null = null,
): Promise<AccountJson[]> {
  const res = await getPool().query<{ result: AccountJson[] }>(
    `SELECT public.list_company_accounts($1::uuid, $2::boolean, $3::integer) AS result`,
    [companyId, activeOnly, accountClass],
  )
  return res.rows[0]!.result
}

async function seedChart(companyId: string): Promise<void> {
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [
    companyId,
  ])
}

async function insertAccount(params: {
  userId: string
  companyId: string
  accountNumber: string
  accountClass: number
  isActive?: boolean
  sortOrder?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (id, user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'expense', 'debit', $8, $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.accountNumber,
      `Testkonto ${params.accountNumber}`,
      params.accountClass,
      params.accountNumber.substring(0, 2),
      params.isActive ?? true,
      params.sortOrder ?? 0,
    ],
  )
  return id
}

describe('list_company_accounts: filtering', () => {
  it('returns only active rows by default and includes inactive with p_active_only=false', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)
    const inactiveId = await insertAccount({
      userId,
      companyId,
      accountNumber: '9998',
      accountClass: 8,
      isActive: false,
    })

    const activeRows = await callRpc(companyId)
    expect(activeRows.length).toBeGreaterThan(0)
    expect(activeRows.every((r) => r.is_active)).toBe(true)
    expect(activeRows.some((r) => r.id === inactiveId)).toBe(false)

    const allRows = await callRpc(companyId, false)
    expect(allRows.some((r) => r.id === inactiveId)).toBe(true)
    expect(allRows.length).toBe(activeRows.length + 1)
  })

  it('filters by p_account_class', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)

    const class3 = await callRpc(companyId, true, 3)
    expect(class3.length).toBeGreaterThan(0)
    expect(class3.every((r) => r.account_class === 3)).toBe(true)

    const expected = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.chart_of_accounts
        WHERE company_id = $1 AND is_active AND account_class = 3`,
      [companyId],
    )
    expect(class3.length).toBe(Number(expected.rows[0]!.n))
  })

  it('returns [] (not NULL) for an unknown company id', async () => {
    const rows = await callRpc(randomUUID())
    expect(rows).toEqual([])
  })
})

describe('list_company_accounts: ordering', () => {
  it('orders by (sort_order, id) with id as the deterministic tiebreaker', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)
    // Two accounts sharing a sort_order: the tie must resolve by id.
    const tieA = await insertAccount({
      userId,
      companyId,
      accountNumber: '9901',
      accountClass: 8,
      sortOrder: 5000,
    })
    const tieB = await insertAccount({
      userId,
      companyId,
      accountNumber: '9902',
      accountClass: 8,
      sortOrder: 5000,
    })

    const rows = await callRpc(companyId)
    const expected = await getPool().query<{ id: string }>(
      `SELECT id FROM public.chart_of_accounts
        WHERE company_id = $1 AND is_active
        ORDER BY sort_order, id`,
      [companyId],
    )
    expect(rows.map((r) => r.id)).toEqual(expected.rows.map((r) => r.id))

    // Explicit tie assertion: uuid ordering in Postgres is bytewise, which
    // matches lexicographic order of the canonical lowercase hex form.
    const [first, second] = [tieA, tieB].sort()
    expect(rows.findIndex((r) => r.id === first)).toBeLessThan(
      rows.findIndex((r) => r.id === second),
    )
    // And the tied pair sits adjacent at the end (highest sort_order).
    expect(rows.slice(-2).map((r) => r.id)).toEqual([first, second])
  })
})

describe('list_company_accounts: select(*) parity', () => {
  it('each element carries the exact column set of chart_of_accounts', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)

    const rows = await callRpc(companyId)
    expect(rows.length).toBeGreaterThan(0)

    const cols = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chart_of_accounts'`,
    )
    const expectedKeys = cols.rows.map((r) => r.column_name).sort()
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(expectedKeys)
    }
  })
})

describe('list_company_accounts: security', () => {
  it('is SECURITY INVOKER: a non-member sees zero rows through RLS', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)
    const outsiderId = await insertAuthUser()

    const rows = await withUserContext(outsiderId, async (client) => {
      const res = await client.query<{ result: AccountJson[] }>(
        `SELECT public.list_company_accounts($1::uuid) AS result`,
        [companyId],
      )
      return res.rows[0]!.result
    })
    expect(rows).toEqual([])
  })

  it('a member sees the company chart through the same RLS policy', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)

    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ result: AccountJson[] }>(
        `SELECT public.list_company_accounts($1::uuid) AS result`,
        [companyId],
      )
      return res.rows[0]!.result
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('list_company_accounts: migration idempotency', () => {
  it('re-executing the migration SQL succeeds and the function still works', async () => {
    await getPool().query(MIGRATION_SQL)

    const { companyId } = await seedCompany()
    await seedChart(companyId)
    const rows = await callRpc(companyId)
    expect(rows.length).toBeGreaterThan(0)
  })
})
