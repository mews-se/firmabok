import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * Caller guard on check_and_increment_agent_quota (migration 20260726090000).
 *
 * The function is SECURITY DEFINER in `public`, so PostgREST exposes it to any
 * authenticated user, and p_user_id is a plain argument. Without a guard, one
 * user could spend another user's minute/day budget and lock them out of every
 * agent endpoint. This test pins the guard against a real Postgres, because a
 * mocked Supabase client cannot see a PL/pgSQL condition at all.
 *
 * Locks in:
 *   - An authenticated caller may spend their OWN quota.
 *   - An authenticated caller spending someone else's quota raises 42501 and
 *     leaves the victim's counters untouched.
 *   - A service-role/superuser connection (auth.uid() IS NULL) may still pass
 *     an explicit user id: cron, tests and backend jobs rely on that.
 */

async function asRole<T>(
  role: 'authenticated' | 'anon',
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function asAuthenticatedUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return asRole('authenticated', userId, fn)
}

async function counterFor(userId: string): Promise<number> {
  const res = await getPool().query<{ count: number }>(
    `SELECT COALESCE(SUM(count), 0)::int AS count
       FROM public.agent_rate_counters
      WHERE user_id = $1`,
    [userId],
  )
  return res.rows[0]?.count ?? 0
}

describe('check_and_increment_agent_quota caller guard.pg', () => {
  it('lets an authenticated user spend their own quota', async () => {
    const userId = await insertAuthUser()

    const result = await asAuthenticatedUser(userId, async (client) => {
      const res = await client.query<{ result: { ok: boolean } }>(
        `SELECT public.check_and_increment_agent_quota($1::uuid, 30, 1000) AS result`,
        [userId],
      )
      return res.rows[0]!.result
    })

    expect(result.ok).toBe(true)
    expect(await counterFor(userId)).toBeGreaterThan(0)
  })

  it('refuses to spend another user quota and leaves their counters untouched', async () => {
    const attacker = await insertAuthUser()
    const victim = await insertAuthUser()

    await expect(
      asAuthenticatedUser(attacker, async (client) => {
        await client.query(
          `SELECT public.check_and_increment_agent_quota($1::uuid, 30, 1000) AS result`,
          [victim],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })

    expect(await counterFor(victim)).toBe(0)
  })

  it('refuses an unauthenticated anon caller entirely', async () => {
    // The anon key ships in the browser bundle, so this RPC is reachable
    // without a session. auth.uid() is NULL for anon exactly as it is for
    // backend roles, so a uid-only guard would have let this through.
    const victim = await insertAuthUser()

    await expect(
      asRole('anon', null, async (client) => {
        await client.query(
          `SELECT public.check_and_increment_agent_quota($1::uuid, 30, 1000) AS result`,
          [victim],
        )
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^42501$/) })

    expect(await counterFor(victim)).toBe(0)
  })

  it('still allows a service-role connection to pass an explicit user id', async () => {
    const userId = await insertAuthUser()

    // The shared pool connects as the migration/superuser role, so auth.uid()
    // is NULL here: the same shape cron jobs and backend scripts run under.
    const res = await getPool().query<{ result: { ok: boolean } }>(
      `SELECT public.check_and_increment_agent_quota($1::uuid, 30, 1000) AS result`,
      [userId],
    )

    expect(res.rows[0]!.result.ok).toBe(true)
    expect(await counterFor(userId)).toBeGreaterThan(0)
  })
})
