import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for migration 20260820210000 (drop the team and
// invitation layer). Required by .claude/rules/database.md for any
// RPC/RLS/trigger change: asserts the layer is gone, that the recreated
// create_company_with_owner works without a team, and that the policies
// rewritten off the team tables still admit the writes they used to.

async function regclass(name: string): Promise<string | null> {
  const { rows } = await getPool().query<{ oid: string | null }>(
    `SELECT to_regclass($1)::text AS oid`,
    [name],
  )
  return rows[0].oid
}

async function functionExists(name: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  )
  return rows.length > 0
}

describe('the team and invitation layer is gone', () => {
  it('has dropped the tables', async () => {
    expect(await regclass('public.teams')).toBeNull()
    expect(await regclass('public.team_members')).toBeNull()
    expect(await regclass('public.team_invitations')).toBeNull()
    expect(await regclass('public.company_invitations')).toBeNull()
  })

  it('has dropped the team functions', async () => {
    for (const fn of [
      'user_team_ids',
      'ensure_user_team',
      'create_team_with_owner',
      'sync_team_to_company',
      'sync_team_member_to_companies',
      'remove_team_member_from_companies',
      'user_is_team_admin',
    ]) {
      expect(await functionExists(fn), `${fn} should be dropped`).toBe(false)
    }
  })

  it('has dropped the team_id columns', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'team_id'`,
    )
    expect(rows).toEqual([])
  })

  it('keeps company_members (the tenancy backbone) intact', async () => {
    expect(await regclass('public.company_members')).not.toBeNull()
    expect(await functionExists('user_company_ids')).toBe(true)
  })
})

describe('create_company_with_owner without a team', () => {
  it('exposes only the 3-arg signature', async () => {
    const { rows } = await getPool().query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_company_with_owner'`,
    )
    expect(rows.map((r) => r.args)).toEqual([
      'p_name text, p_entity_type text, p_set_active boolean',
    ])
  })

  it('creates company + owner membership + active preference', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT public.create_company_with_owner('Nya firman', 'enskild_firma') AS id`,
      )
      const companyId = rows[0].id
      expect(companyId).toBeTruthy()

      const member = await client.query(
        `SELECT role FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
        [companyId, userId],
      )
      expect(member.rows[0]?.role).toBe('owner')

      const prefs = await client.query(
        `SELECT active_company_id FROM public.user_preferences WHERE user_id = $1`,
        [userId],
      )
      expect(prefs.rows[0]?.active_company_id).toBe(companyId)
    })
  })
})

describe('policies rewritten off the team tables', () => {
  it('lets an owner insert a voucher gap explanation via company_members role', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, active_company_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
      [userId, companyId],
    )

    await withUserContext(userId, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO public.voucher_gap_explanations
           (company_id, user_id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation)
         VALUES ($1, $2, $3, 'A', 5, 5, 'Makulerat verifikat')`,
        [companyId, userId, fiscalPeriodId],
      )
      expect(rowCount).toBe(1)
    })
  })

  it('still refuses a booking template insert for a foreign company', async () => {
    const { userId, companyId } = await seedCompany()
    const outsider = await seedCompany()
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, active_company_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
      [userId, companyId],
    )

    await withUserContext(userId, async (client) => {
      // Own company: accepted.
      const ok = await client.query(
        `INSERT INTO public.booking_template_library
           (company_id, created_by, name, description, category, entity_type, lines, is_system)
         VALUES ($1, $2, 'Egen mall', '', 'other', 'all', '[]'::jsonb, false)`,
        [companyId, userId],
      )
      expect(ok.rowCount).toBe(1)

      // Someone else's company: refused by btl_insert.
      await expect(
        client.query(
          `INSERT INTO public.booking_template_library
             (company_id, created_by, name, description, category, entity_type, lines, is_system)
           VALUES ($1, $2, 'Fel bolag', '', 'other', 'all', '[]'::jsonb, false)`,
          [outsider.companyId, userId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })
})
