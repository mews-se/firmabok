import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from './fixtures'
import { getPool } from './setup'

describe('API-key audit history', () => {
  it('skips request telemetry while retaining security and configuration changes', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const apiKeyId = randomUUID()
    const keyHash = randomUUID().replaceAll('-', '')

    await getPool().query(
      `INSERT INTO public.api_keys
         (id, user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Audit test key', $5)`,
      [apiKeyId, userId, companyId, keyHash, ['reports:read']],
    )

    await getPool().query(
      `SELECT * FROM public.validate_and_increment_api_key($1)`,
      [keyHash],
    )
    await getPool().query(
      `SELECT * FROM public.validate_and_increment_api_key($1)`,
      [keyHash],
    )

    const afterTelemetry = await getPool().query<{ action: string }>(
      `SELECT action
       FROM public.audit_log
       WHERE table_name = 'api_keys'
         AND record_id = $1
       ORDER BY created_at, id`,
      [apiKeyId],
    )
    expect(afterTelemetry.rows.map((row) => row.action)).toEqual(['INSERT'])

    await getPool().query(
      `UPDATE public.api_keys
       SET name = 'Renamed audit test key',
           scopes = ARRAY['reports:read', 'customers:read']::text[]
       WHERE id = $1`,
      [apiKeyId],
    )

    const afterConfigurationChange = await getPool().query<{
      action: string
      old_name: string | null
      new_name: string | null
    }>(
      `SELECT
         action,
         old_state ->> 'name' AS old_name,
         new_state ->> 'name' AS new_name
       FROM public.audit_log
       WHERE table_name = 'api_keys'
         AND record_id = $1
       ORDER BY created_at, id`,
      [apiKeyId],
    )

    expect(afterConfigurationChange.rows).toEqual([
      { action: 'INSERT', old_name: null, new_name: 'Audit test key' },
      {
        action: 'UPDATE',
        old_name: 'Audit test key',
        new_name: 'Renamed audit test key',
      },
    ])
  })
})
