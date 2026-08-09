import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Guards migration 20260726130000: the credit-note cap is on AMOUNT, not COUNT.
 *
 * ML (2023:200) 17 kap 22-23 SS permits a partial aendringsfaktura, so the
 * previous UNIQUE index on (company_id, credited_invoice_id) was over-broad.
 * What must stay impossible is crediting MORE than the original invoice.
 */

async function insertInvoice(input: {
  userId: string
  companyId: string
  number: string
  total: number
  // Explicit null inserts a NULL. Both columns are nullable with a default
  // (`status text default 'draft'`, `currency text default 'SEK'`) and neither
  // CHECK rejects NULL, so these are reachable row shapes, not synthetic ones.
  currency?: string | null
  status?: string | null
  creditedInvoiceId?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        status, currency, total, credited_invoice_id)
     VALUES ($1, $2, $3, $4, '2026-07-26', '2026-07-26', $5, $6, $7, $8)`,
    [
      id,
      input.userId,
      input.companyId,
      input.number,
      input.status === undefined ? 'sent' : input.status,
      input.currency === undefined ? 'SEK' : input.currency,
      input.total,
      input.creditedInvoiceId ?? null,
    ],
  )
  return id
}

describe('credit note amount cap', () => {
  it('drops the old one-credit-note-per-invoice unique index', async () => {
    const index = await getPool().query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'uq_invoices_company_credited_invoice'`,
    )
    expect(index.rows).toHaveLength(0)
  })

  it('allows two partial credit notes that stay within the original total', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })

    await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -5000,
      creditedInvoiceId: originalId,
    })
    await insertInvoice({
      userId,
      companyId,
      number: `KR2-${randomUUID()}`,
      total: -7500,
      creditedInvoiceId: originalId,
    })

    const credited = await getPool().query<{ sum: string }>(
      `SELECT COALESCE(SUM(ABS(total)), 0)::text AS sum
       FROM public.invoices WHERE credited_invoice_id = $1`,
      [originalId],
    )
    expect(Number(credited.rows[0].sum)).toBe(12500)
  })

  it('refuses a credit note that pushes the credited total past the original', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })

    await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -10000,
      creditedInvoiceId: originalId,
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -2500.02,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)
  })

  it('still refuses two full mirrors of the same invoice (no double reversal)', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })

    await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -12500,
      creditedInvoiceId: originalId,
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -12500,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)
  })

  it('frees the credited amount again when a credit note is cancelled', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })
    const firstCreditId = await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -12500,
      creditedInvoiceId: originalId,
    })

    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [
      firstCreditId,
    ])

    // A replacement credit note now fits again.
    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -12500,
        creditedInvoiceId: originalId,
      }),
    ).resolves.toBeTruthy()
  })

  // The sibling sum decides how much capacity is left, so a sibling that falls
  // out of it hands out capacity that is already spent. `status <> 'cancelled'`
  // is NULL for a NULL-status row and excludes it; COALESCE(status, '') counts
  // it. These two cases are the whole reason for that COALESCE.
  it('counts a NULL-status sibling against the cap', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })

    await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -12500,
      status: null,
      creditedInvoiceId: originalId,
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -12500,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)
  })

  it('caps an incoming NULL-status credit note instead of treating it as cancelled', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
    })

    await insertInvoice({
      userId,
      companyId,
      number: `KR1-${randomUUID()}`,
      total: -12500,
      creditedInvoiceId: originalId,
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -12500,
        status: null,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)
  })

  it('refuses a credit note denominated in another currency than the original', async () => {
    const { userId, companyId } = await seedCompany()
    const originalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
      currency: 'SEK',
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR-${randomUUID()}`,
        total: -1000,
        currency: 'EUR',
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/currency/i)
  })

  // invoices.currency is nullable with `default 'SEK'`, so the assert resolves a
  // NULL to SEK rather than opting out of the comparison: skipping on NULL let a
  // NULL-currency credit note be capped against a EUR original in a unit nobody
  // had agreed on.
  it('treats a NULL currency as SEK on both sides of the assert', async () => {
    const { userId, companyId } = await seedCompany()
    const eurOriginalId = await insertInvoice({
      userId,
      companyId,
      number: `F-${randomUUID()}`,
      total: 12500,
      currency: 'EUR',
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR-${randomUUID()}`,
        total: -1000,
        currency: null,
        creditedInvoiceId: eurOriginalId,
      }),
    ).rejects.toThrow(/currency/i)

    const sekOriginalId = await insertInvoice({
      userId,
      companyId,
      number: `F2-${randomUUID()}`,
      total: 12500,
      currency: 'SEK',
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR2-${randomUUID()}`,
        total: -1000,
        currency: null,
        creditedInvoiceId: sekOriginalId,
      }),
    ).resolves.toBeTruthy()
  })

  // The trigger reads the original with SECURITY DEFINER (RLS bypassed), so
  // the company match in its lookup is what stops a credit note in one
  // company from FOR UPDATE-locking another tenant's invoice and leaking its
  // total/currency through the exception text. A cross-company reference is
  // treated as not found and the insert is rejected.
  it('rejects a credit note that references another tenant\'s invoice', async () => {
    const victim = await seedCompany()
    const attacker = await seedCompany()

    const victimInvoiceId = await insertInvoice({
      userId: victim.userId,
      companyId: victim.companyId,
      number: `F-${randomUUID()}`,
      total: 98765.43,
    })

    let raised: Error | null = null
    try {
      await insertInvoice({
        userId: attacker.userId,
        companyId: attacker.companyId,
        number: `KR-${randomUUID()}`,
        total: -1000,
        creditedInvoiceId: victimInvoiceId,
      })
    } catch (err) {
      raised = err as Error
    }
    expect(raised).not.toBeNull()
    expect(raised!.message).toMatch(/not found for credit note/i)
    // The exception must not leak the victim invoice's figures.
    expect(raised!.message).not.toContain('98765.43')
  })

  it('leaves ordinary invoices untouched', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `F-${randomUUID()}`,
        total: 12500,
      }),
    ).resolves.toBeTruthy()
  })
})
