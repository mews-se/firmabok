import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Smoke for transactions.document_id (added 20260505140000, hardened in
 * 20260506090000 and 20260506100000).
 *
 * Locks in:
 *   - FK exists and points at document_attachments(id).
 *   - ON DELETE RESTRICT: deleting a doc that is pinned to any tx is blocked.
 *   - enforce_transactions_document_immutability trigger blocks UPDATE on
 *     transactions.document_id when the previously-pinned document has
 *     propagated to a journal entry (BFL 5 kap 6 §).
 */

async function insertDocument(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  const storagePath = `documents/${params.companyId}/test.pdf`
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0')
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes,
        storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'test.pdf', 'application/pdf', 1024,
             $4, $5, 'file_upload')`,
    [id, params.userId, params.companyId, storagePath, sha256],
  )
  return id
}

async function insertTransaction(params: {
  userId: string
  companyId: string
  documentId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, document_id)
     VALUES ($1, $2, $3, '2026-05-01', 'Test tx', -1000, 'SEK', $4)`,
    [id, params.userId, params.companyId, params.documentId ?? null],
  )
  return id
}

async function insertJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 1, 'A', '2026-05-01', 'Test', 'manual', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId],
  )
  return id
}

describe('transactions.document_id.pg', () => {
  it('attaches a document to a transaction and reads it back', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument({ userId, companyId })
    const txId = await insertTransaction({ userId, companyId, documentId: docId })

    const res = await getPool().query<{ document_id: string | null }>(
      `SELECT document_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(res.rows[0]!.document_id).toBe(docId)
  })

  it('ON DELETE RESTRICT: blocks deletion of a doc still pinned to a tx', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument({ userId, companyId })
    await insertTransaction({ userId, companyId, documentId: docId })

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [docId]),
    ).rejects.toThrow(/violates foreign key constraint|still referenced/)
  })

  it('detaching first then deleting the doc succeeds', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument({ userId, companyId })
    const txId = await insertTransaction({ userId, companyId, documentId: docId })

    await getPool().query(
      `UPDATE public.transactions SET document_id = NULL WHERE id = $1`,
      [txId],
    )
    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [docId])

    const res = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM public.document_attachments WHERE id = $1`,
      [docId],
    )
    expect(res.rows[0]!.count).toBe('0')
  })

  it('blocks UPDATE that detaches a document already linked to a journal entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const docId = await insertDocument({ userId, companyId })
    const txId = await insertTransaction({ userId, companyId, documentId: docId })
    const jeId = await insertJournalEntry({ userId, companyId, fiscalPeriodId })

    // Simulate the categorize propagation: doc is now räkenskapsinformation.
    await getPool().query(
      `UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`,
      [jeId, docId],
    )

    await expect(
      getPool().query(
        `UPDATE public.transactions SET document_id = NULL WHERE id = $1`,
        [txId],
      ),
    ).rejects.toThrow(/BFL_DOCUMENT_IMMUTABILITY/)

    // And blocks swapping to a different document.
    const otherDocId = await insertDocument({ userId, companyId })
    await expect(
      getPool().query(
        `UPDATE public.transactions SET document_id = $1 WHERE id = $2`,
        [otherDocId, txId],
      ),
    ).rejects.toThrow(/BFL_DOCUMENT_IMMUTABILITY/)
  })

  it('allows detach when the document is not yet on a journal entry', async () => {
    const { userId, companyId } = await seedCompany()
    const docId = await insertDocument({ userId, companyId })
    const txId = await insertTransaction({ userId, companyId, documentId: docId })

    await getPool().query(
      `UPDATE public.transactions SET document_id = NULL WHERE id = $1`,
      [txId],
    )

    const res = await getPool().query<{ document_id: string | null }>(
      `SELECT document_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(res.rows[0]!.document_id).toBeNull()
  })
})
