import { beforeAll, describe, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The pending_operations_operation_type_check constraint must accept the
 * 'update_invoice' op type added by migration 20260727090000 (validated in
 * 20260727090001). Without the constraint expansion, gnubok_update_invoice's
 * staging INSERT fails with check_violation on every real call while dry_run
 * (which skips the INSERT) previews clean: the exact bug class the op-type
 * audit test documents for gnubok_link_document_to_voucher.
 */
describe('pending_operations operation_type CHECK: update_invoice', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('accepts update_invoice (constraint expanded in 20260727090000)', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, 'update_invoice', 'regression: uppdatera fakturautkast')`,
        [userId, companyId],
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
