import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Constraint coverage for migration 20260727110000: the re-created
 * pending_operations_operation_type_check must accept the two new
 * recurring-schedule op types (and must not have silently dropped the
 * concurrently-added update_invoice value: the constraint is re-created
 * wholesale from a full value list, so an omission there revokes the type).
 *
 * The broader drift guard lives in pending-operations-op-type-audit.pg.test.ts
 * (it derives op types from staging call sites + risk tiers); this file pins
 * the specific values so a failure names the migration directly.
 */

const NEW_OP_TYPES = [
  'create_recurring_schedule',
  'update_recurring_schedule',
  // Added by 20260727090000, re-listed by 20260727110000: must survive both.
  'update_invoice',
] as const

describe('pending_operations operation_type CHECK: recurring schedules', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it.each(NEW_OP_TYPES)('accepts %s', async (opType) => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
         VALUES ($1, $2, $3, $4)`,
        [userId, companyId, opType, `constraint check: ${opType}`],
      )
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('still rejects an unknown operation type', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await expect(
        client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
           VALUES ($1, $2, 'run_recurring_schedule_now', 'must not exist: deliberately deferred')`,
          [userId, companyId],
        ),
      ).rejects.toThrow(/pending_operations_operation_type_check/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
