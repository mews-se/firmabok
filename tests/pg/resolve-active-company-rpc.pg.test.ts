import { describe, it, expect } from 'vitest'
import { getPool, getClient, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

// Validates migration 20260723161000_resolve_active_company_rpc:
//   1. resolve_active_company() mirrors the JS resolution exactly: validated
//      preference wins, else earliest non-archived membership by
//      company_members.created_at, else NULL.
//   2. used_fallback is true exactly when the validated preference is
//      absent (middleware's write-back condition).
//   3. NULL auth.uid() (service-role clients) returns ZERO rows by design.
//   4. EXECUTE is granted to authenticated only, not anon.
//   5. Divergence guard: it never disagrees with
//      current_active_company_id(), which RLS reads.

const RESOLVE = `SELECT r.company_id::text AS company_id, r.locale, r.used_fallback
                 FROM public.resolve_active_company() r`

type ResolveRow = { company_id: string | null; locale: string | null; used_fallback: boolean }

async function setPrefs(
  userId: string,
  activeCompanyId: string | null,
  locale?: string,
): Promise<void> {
  if (locale === undefined) {
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, active_company_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
      [userId, activeCompanyId],
    )
    return
  }
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id, locale)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET active_company_id = EXCLUDED.active_company_id, locale = EXCLUDED.locale`,
    [userId, activeCompanyId, locale],
  )
}

describe('resolve_active_company()', () => {
  it('resolves a valid preference with used_fallback false and the default locale', async () => {
    const { userId, companyId } = await seedCompany()
    await setPrefs(userId, companyId)
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].company_id).toBe(companyId)
      expect(res.rows[0].used_fallback).toBe(false)
      // locale column is NOT NULL DEFAULT 'sv' (20260521120000): a prefs row
      // always carries a locale.
      expect(res.rows[0].locale).toBe('sv')
    })
  })

  it('falls back to the first membership with used_fallback true and null locale when there is no prefs row', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].company_id).toBe(companyId)
      expect(res.rows[0].used_fallback).toBe(true)
      expect(res.rows[0].locale).toBeNull()
    })
  })

  it('orders the fallback by company_members.created_at ASC, not insertion order', async () => {
    const userId = await insertAuthUser()
    const firstInserted = await insertCompany({ createdBy: userId, name: 'First Inserted AB' })
    const backdated = await insertCompany({ createdBy: userId, name: 'Backdated AB' })
    await insertCompanyMember({ companyId: firstInserted, userId })
    await insertCompanyMember({ companyId: backdated, userId })
    // Backdate the SECOND membership: it must win despite later insertion.
    await getPool().query(
      `UPDATE public.company_members SET created_at = now() - interval '1 day'
       WHERE company_id = $1 AND user_id = $2`,
      [backdated, userId],
    )
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows[0].company_id).toBe(backdated)
      expect(res.rows[0].used_fallback).toBe(true)
    })
  })

  it('ignores a preference pointing at an archived company and falls back', async () => {
    const userId = await insertAuthUser()
    const archived = await insertCompany({ createdBy: userId, name: 'Archived AB' })
    const alive = await insertCompany({ createdBy: userId, name: 'Alive AB' })
    await insertCompanyMember({ companyId: archived, userId })
    await insertCompanyMember({ companyId: alive, userId })
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [
      archived,
    ])
    await setPrefs(userId, archived)
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows[0].company_id).toBe(alive)
      expect(res.rows[0].used_fallback).toBe(true)
    })
  })

  it('ignores a preference pointing at a company the user is not a member of', async () => {
    const { companyId: foreignCompany } = await seedCompany() // someone else's
    const { userId, companyId: ownCompany } = await seedCompany()
    await setPrefs(userId, foreignCompany)
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows[0].company_id).toBe(ownCompany)
      expect(res.rows[0].used_fallback).toBe(true)
    })
  })

  it('returns one row with a null company_id but the stored locale for a user with prefs and zero memberships', async () => {
    const userId = await insertAuthUser()
    await setPrefs(userId, null, 'en')
    await withUserContext(userId, async (client) => {
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0].company_id).toBeNull()
      expect(res.rows[0].locale).toBe('en')
      expect(res.rows[0].used_fallback).toBe(true)
    })
  })

  it('returns ZERO rows when auth.uid() is NULL (service-role clients)', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // A claims object with no `sub`: auth.uid() resolves to NULL, the
      // shape a service-role/backend connection presents.
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: 'authenticated' }),
      ])
      await client.query(`SET LOCAL ROLE authenticated`)
      const res = await client.query<ResolveRow>(RESOLVE)
      expect(res.rows).toHaveLength(0)
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('grants EXECUTE to authenticated but not anon', async () => {
    const res = await getPool().query<{ anon_can: boolean; authenticated_can: boolean }>(
      `SELECT
         has_function_privilege('anon', 'public.resolve_active_company()', 'EXECUTE') AS anon_can,
         has_function_privilege('authenticated', 'public.resolve_active_company()', 'EXECUTE') AS authenticated_can`,
    )
    expect(res.rows[0].anon_can).toBe(false)
    expect(res.rows[0].authenticated_can).toBe(true)
  })

  it('never diverges from current_active_company_id(), which RLS reads', async () => {
    // Stale-pref scenario: the most divergence-prone shape (pref set, but
    // membership on the preferred company is gone).
    const { companyId: foreignCompany } = await seedCompany()
    const { userId } = await seedCompany()
    await setPrefs(userId, foreignCompany)
    await withUserContext(userId, async (client) => {
      const res = await client.query<{ agrees: boolean }>(
        `SELECT (SELECT r.company_id FROM public.resolve_active_company() r)
                IS NOT DISTINCT FROM public.current_active_company_id() AS agrees`,
      )
      expect(res.rows[0].agrees).toBe(true)
    })
  })
})
