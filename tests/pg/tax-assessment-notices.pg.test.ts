import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

async function insertNotice(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  decisionDate?: string
  paymentDueDate?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.tax_assessment_notices
       (id, company_id, user_id, fiscal_period_id, decision_type, decision_date, payment_due_date)
     VALUES ($1, $2, $3, $4, 'final', $5, $6)`,
    [
      id,
      params.companyId,
      params.userId,
      params.fiscalPeriodId,
      params.decisionDate ?? '2026-07-01',
      params.paymentDueDate ?? '2026-10-12',
    ],
  )
  return id
}

describe('tax_assessment_notices constraints and RLS', () => {
  it('isolates notices by company membership', async () => {
    const owner = await seedCompany()
    const noticeId = await insertNotice(owner)
    const strangerId = await insertAuthUser()

    const ownerView = await withUserContext(owner.userId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM public.tax_assessment_notices WHERE id = $1`,
        [noticeId],
      ),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(strangerId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM public.tax_assessment_notices WHERE id = $1`,
        [noticeId],
      ),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('rejects inserts into another company', async () => {
    const owner = await seedCompany()
    const strangerId = await insertAuthUser()

    await expect(withUserContext(strangerId, (client) =>
      client.query(
        `INSERT INTO public.tax_assessment_notices
           (company_id, user_id, fiscal_period_id, decision_type, decision_date, payment_due_date)
         VALUES ($1, $2, $3, 'final', '2026-07-01', '2026-10-12')`,
        [owner.companyId, strangerId, owner.fiscalPeriodId],
      ),
    )).rejects.toThrow(/row-level security|policy/i)
  })

  it('requires the exact due date to be on or after the decision date', async () => {
    const owner = await seedCompany()
    await expect(insertNotice({
      ...owner,
      decisionDate: '2026-07-01',
      paymentDueDate: '2026-06-30',
    })).rejects.toThrow(/due_after_decision|check constraint/i)
  })

  it('prevents deleting a notice referenced by a generated deadline', async () => {
    const owner = await seedCompany()
    const noticeId = await insertNotice(owner)
    await getPool().query(
      `INSERT INTO public.deadlines
         (user_id, company_id, title, due_date, deadline_type, source,
          tax_deadline_type, tax_period, tax_assessment_notice_id)
       VALUES ($1, $2, 'Kvarskatt', '2026-10-12', 'tax', 'system',
               'kvarskatt', $3, $4)`,
      [owner.userId, owner.companyId, `notice:${noticeId}`, noticeId],
    )

    await expect(
      getPool().query(`DELETE FROM public.tax_assessment_notices WHERE id = $1`, [noticeId]),
    ).rejects.toThrow(/foreign key|violates/i)
  })
})

describe('company_settings initial setup state', () => {
  it('accepts supported paths and rejects unknown values', async () => {
    const owner = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, onboarding_complete, initial_setup_path)
       VALUES ($1, $2, true, 'migration')`,
      [owner.userId, owner.companyId],
    )

    await expect(
      getPool().query(
        `UPDATE public.company_settings SET initial_setup_path = 'unknown' WHERE company_id = $1`,
        [owner.companyId],
      ),
    ).rejects.toThrow(/initial_setup_path_check|check constraint/i)
  })
})
