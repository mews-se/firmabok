import { describe, expect, it } from 'vitest'
import { getClient } from '@/tests/pg/setup'

/**
 * Migration 20260602145425_lock_down_oauth_used_codes.sql enables RLS on
 * public.oauth_used_codes and REVOKEs all privileges from the browser-facing
 * `anon` and `authenticated` roles. The OAuth token endpoint reaches this
 * replay-tracking table only through a service-role client (which bypasses
 * both RLS and the revoke), so the API roles must be denied. These tests lock
 * that contract in so a future migration cannot silently re-expose the table.
 */
describe('oauth_used_codes lockdown (pg)', () => {
  async function expectDenied(role: 'anon' | 'authenticated', sql: string) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(client.query(sql)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('denies SELECT to the anon role', async () => {
    await expectDenied('anon', 'SELECT * FROM public.oauth_used_codes LIMIT 1')
  })

  it('denies SELECT to the authenticated role', async () => {
    await expectDenied('authenticated', 'SELECT * FROM public.oauth_used_codes LIMIT 1')
  })

  it('denies INSERT to the authenticated role', async () => {
    await expectDenied(
      'authenticated',
      `INSERT INTO public.oauth_used_codes (code_hash) VALUES ('lockdown-test')`,
    )
  })

  it('still allows the privileged (service-role / owner) connection to read', async () => {
    // The app reaches this table through a service-role client, which bypasses
    // RLS and the anon/authenticated revoke. Model that with the default
    // privileged pg connection (table owner) the pg-real harness uses.
    const client = await getClient()
    try {
      const res = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.oauth_used_codes',
      )
      expect(res.rows[0]!.n).toBeGreaterThanOrEqual(0)
    } finally {
      client.release()
    }
  })
})
