import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

async function insertInvoice(input: {
  userId: string
  companyId: string
  number: string
  total?: number
  creditedInvoiceId?: string
  creationComplete?: boolean
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date,
        total, credited_invoice_id, creation_complete)
     VALUES ($1, $2, $3, $4, '2026-07-15', '2026-07-15', $5, $6, $7)`,
    [
      id,
      input.userId,
      input.companyId,
      input.number,
      input.total ?? 0,
      input.creditedInvoiceId ?? null,
      input.creationComplete ?? true,
    ],
  )
  return id
}

describe('credit note creation and posting guards', () => {
  // 20260726130000 replaced the one-credit-note-per-original UNIQUE index with an
  // amount cap: partial credit notes are legal (ML 17 kap 22-23 SS), crediting
  // beyond the original total is not. Full coverage of the new invariant lives in
  // credit-note-amount-cap.pg.test.ts; this asserts the double-reversal case the
  // old index existed to prevent is still blocked.
  it('refuses a second full-value credit note for the same original', async () => {
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
      number: `KR-${randomUUID()}`,
      total: -12500,
      creditedInvoiceId: originalId,
    })

    await expect(
      insertInvoice({
        userId,
        companyId,
        number: `KR-${randomUUID()}`,
        total: -12500,
        creditedInvoiceId: originalId,
      }),
    ).rejects.toThrow(/exceeds the invoice total/i)
  })

  it('persists the completion marker and installs a unique posted-source guard', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice({
      userId,
      companyId,
      number: `KR-${randomUUID()}`,
      creationComplete: false,
    })

    const invoice = await getPool().query<{ creation_complete: boolean }>(
      `SELECT creation_complete FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(invoice.rows[0].creation_complete).toBe(false)

    const index = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'uq_posted_credit_note_journal_source'`,
    )
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0].indexdef).toMatch(/UNIQUE/)
    expect(index.rows[0].indexdef).toMatch(/source_type.*credit_note/)
    expect(index.rows[0].indexdef).toMatch(/status.*posted/)
  })
})
