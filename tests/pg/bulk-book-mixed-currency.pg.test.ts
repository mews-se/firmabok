import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260726100000_bulk_book_transactions_currency_guard:
 *
 * bulk_book_transactions used to sum v_tx.amount across the selection
 * without looking at v_tx.currency, so a SEK + EUR batch produced a single
 * scalar (100 EUR + 100 SEK = 200) and a samlingsverifikat stating an
 * amount that matched no affärshändelse. BFL 4 kap 6 § requires one
 * redovisningsvaluta; BFL 5 kap 7 § requires the verifikat's belopp to be
 * the real one. The guard now refuses with BULK_BOOK_MIXED_CURRENCY.
 *
 * The SQL guard matters independently of the HTTP route: `authenticated`
 * holds EXECUTE on this RPC, so a browser session can call it directly over
 * PostgREST, and lib/pending-operations/commit.ts passes tx_ids straight
 * through.
 *
 * A HOMOGENEOUS non-SEK batch is refused too (BULK_BOOK_FOREIGN_CURRENCY):
 * journal_entry_lines.debit_amount / credit_amount are ALWAYS kronor, and the
 * RPC has no exchange rate, so two EUR transactions of 100 + 200 would post a
 * verifikat whose 300 reads as kronor in balansräkning, moms and SIE export.
 *
 * Cases:
 *   - create-new path refuses a mixed-currency selection
 *   - link-existing path refuses the same selection
 *   - NULL currency is read as the column default 'SEK' and stays bookable
 *   - a homogeneous non-SEK batch is refused and nothing is written
 */

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
  date?: string
  currency?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, 'Bank tx', $5, $6, 'uncategorized')`,
    [
      id,
      params.userId,
      params.companyId,
      params.date ?? '2026-06-05',
      params.amount,
      params.currency === undefined ? 'SEK' : params.currency,
    ],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1930', 'Bankkonto',             1, 'asset',   'debit'),
       ('2611', 'Utgående moms 25%',     2, 'liability', 'credit'),
       ('3001', 'Försäljning 25% moms',  3, 'revenue', 'credit')
     ) AS t(n, name, cls, atype, nbal)`,
    [userId, companyId],
  )
  return { userId, companyId, fiscalPeriodId }
}

interface RpcResult {
  ok: boolean
  code?: string
  details?: { currencies?: string[]; currency?: string }
  mode?: 'link_existing' | 'create_new'
  journal_entry_id?: string
  linked_tx_count?: number
  tx_sum?: number
}

describe('bulk_book_transactions: currency homogeneity (BFL 4 kap 6 §)', () => {
  it('refuses a mixed-currency selection on the create-new path', async () => {
    const { userId, companyId } = await seedTenant()
    const sekTx = await insertTransaction({ userId, companyId, amount: 100, currency: 'SEK' })
    const eurTx = await insertTransaction({ userId, companyId, amount: 100, currency: 'EUR' })

    // The caller-built lines look internally consistent against the naive
    // scalar sum (200) the old body computed: that is exactly the booking
    // the guard must stop.
    const newEntry = {
      description: 'Samlingsverifikation 2026-06-05',
      lines: [
        { account_number: '1930', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[sekTx, eurTx], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_MIXED_CURRENCY')
      expect(result.details?.currencies).toEqual(expect.arrayContaining(['SEK', 'EUR']))

      // Nothing was posted and nothing was linked.
      const jes = await client.query(
        `SELECT id FROM public.journal_entries WHERE company_id = $1`,
        [companyId],
      )
      expect(jes.rows).toHaveLength(0)
      const links = await client.query(
        `SELECT transaction_id FROM public.transaction_voucher_links WHERE company_id = $1`,
        [companyId],
      )
      expect(links.rows).toHaveLength(0)
    })
  })

  it('refuses a mixed-currency selection on the link-existing path', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const sekTx = await insertTransaction({ userId, companyId, amount: 100, currency: 'SEK' })
    const eurTx = await insertTransaction({ userId, companyId, amount: 100, currency: 'EUR' })

    // Posted verifikat whose bank net (+200) matches the naive scalar sum,
    // so only the currency guard can reject this.
    const jeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Manual dagssumma', 'manual', 'draft')`,
      [jeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 200, 0), ($1, '3001', 0, 200)`,
      [jeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [jeId])

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3, $4)`,
        [[sekTx, eurTx], jeId, null, companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_MIXED_CURRENCY')

      const links = await client.query(
        `SELECT transaction_id FROM public.transaction_voucher_links WHERE journal_entry_id = $1`,
        [jeId],
      )
      expect(links.rows).toHaveLength(0)
    })
  })

  it('treats NULL currency as the column default SEK and still books', async () => {
    const { userId, companyId } = await seedTenant()
    const legacyTx = await insertTransaction({ userId, companyId, amount: 100, currency: null })
    const sekTx = await insertTransaction({ userId, companyId, amount: 200, currency: 'SEK' })

    const newEntry = {
      description: 'Samlingsverifikation 2026-06-05',
      lines: [
        { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'SEK' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[legacyTx, sekTx], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(true)
      expect(result.linked_tx_count).toBe(2)
      expect(result.tx_sum).toBe(300)
    })
  })

  it('refuses a homogeneous non-SEK selection (the ledger columns are always kronor)', async () => {
    const { userId, companyId } = await seedTenant()
    const eur1 = await insertTransaction({ userId, companyId, amount: 100, currency: 'EUR' })
    const eur2 = await insertTransaction({ userId, companyId, amount: 200, currency: 'EUR' })

    // The old body accepted this batch and wrote 300 into the always-SEK
    // debit/credit columns: a verifikat read as 300 kronor by balansräkning,
    // moms and SIE while the affärshändelse was 300 euro.
    const newEntry = {
      description: 'Samlingsverifikation EUR 2026-06-05',
      lines: [
        { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'EUR' },
        { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'EUR' },
      ],
    }

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ bulk_book_transactions: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, $3::jsonb, $4)`,
        [[eur1, eur2], null, JSON.stringify(newEntry), companyId],
      )
      const result = r.rows[0]!.bulk_book_transactions
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BULK_BOOK_FOREIGN_CURRENCY')
      expect(result.details?.currency).toBe('EUR')

      // Nothing was posted and nothing was linked.
      const jes = await client.query(
        `SELECT id FROM public.journal_entries WHERE company_id = $1`,
        [companyId],
      )
      expect(jes.rows).toHaveLength(0)
      const links = await client.query(
        `SELECT transaction_id FROM public.transaction_voucher_links WHERE company_id = $1`,
        [companyId],
      )
      expect(links.rows).toHaveLength(0)
    })
  })
})
