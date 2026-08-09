import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * Storage RLS for the `documents` bucket after
 * 20260726092000_documents_bucket_company_scope.sql.
 *
 * The bug this guards: the original policies (20240101000024) scoped the
 * bucket on the UPLOADER, `(storage.foldername(name))[2] = auth.uid()::text`.
 * company_id appeared nowhere in the policy or the key, so deleting a
 * company_members row revoked nothing: the ex-member's session still
 * authenticated, auth.uid() was unchanged, and they kept direct Storage read
 * access to every kvitto and leverantorsfaktura they had uploaded. Those are
 * records under the BFL 7 kap 2 § seven-year retention requirement, so the
 * exposure is both a GDPR Art. 32 access-control failure and long-lived.
 *
 * The company-scoped layout is documents/{companyId}/{userId}/{ts}_{file};
 * access follows public.user_company_ids(), i.e. current membership.
 */
describe('documents bucket: company-scoped storage policies', () => {
  const objectNames: string[] = []

  let ownerA: string
  let memberA: string
  let outsider: string
  let exMember: string
  let companyA: string
  let companyB: string

  let keyUploadedByOwner: string
  let keyUploadedByExMember: string
  let keyInCompanyB: string
  let legacyKey: string

  async function seedObject(name: string): Promise<void> {
    await getPool().query(
      `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`,
      [name],
    )
    objectNames.push(name)
  }

  beforeAll(async () => {
    // The bucket row: the migration inserts it, but a bucket-less CI image
    // would fail the FK on storage.objects with a confusing error.
    await getPool().query(
      `INSERT INTO storage.buckets (id, name, public)
       VALUES ('documents', 'documents', false)
       ON CONFLICT (id) DO NOTHING`,
    )

    // Real Supabase grants table privileges on storage.objects to the
    // `authenticated` role; the bare postgres image used in CI may not.
    // Without this the assertions below fail with "permission denied" and
    // say nothing about the policies we are actually testing.
    await getPool()
      .query(`GRANT SELECT, INSERT ON storage.objects TO authenticated`)
      .catch(() => {})

    ownerA = await insertAuthUser()
    memberA = await insertAuthUser()
    outsider = await insertAuthUser()
    exMember = await insertAuthUser()

    companyA = await insertCompany({ createdBy: ownerA, name: 'Company A AB' })
    companyB = await insertCompany({ createdBy: outsider, name: 'Company B AB' })

    await insertCompanyMember({ companyId: companyA, userId: ownerA, role: 'owner' })
    await insertCompanyMember({ companyId: companyA, userId: memberA, role: 'member' })
    await insertCompanyMember({ companyId: companyB, userId: outsider, role: 'owner' })

    // exMember uploaded underlag for company A while they were a member; the
    // membership row is deleted further down, in the regression test itself.
    await insertCompanyMember({ companyId: companyA, userId: exMember, role: 'member' })

    keyUploadedByOwner = `documents/${companyA}/${ownerA}/1700000000000_kvitto.pdf`
    keyUploadedByExMember = `documents/${companyA}/${exMember}/1700000000001_kvitto.pdf`
    keyInCompanyB = `documents/${companyB}/${outsider}/1700000000002_kvitto.pdf`
    legacyKey = `documents/${ownerA}/1700000000003_kvitto.pdf`

    await seedObject(keyUploadedByOwner)
    await seedObject(keyUploadedByExMember)
    await seedObject(keyInCompanyB)
    await seedObject(legacyKey)
    // A non-document shape the bucket also holds: the MCP audit-package tool
    // writes `{userId}/audit-packages/...`. Its second segment is NOT a UUID,
    // which is exactly why the policy compares path segments as text instead
    // of casting them like the sie-files precedent does.
    await seedObject(`${ownerA}/audit-packages/1700000000004_archive.zip`)
  })

  afterAll(async () => {
    // Best effort: seeding happens on the superuser pool (outside the
    // rolled-back user transactions), so it must be swept. A residual FK from
    // a trigger-seeded child row must not turn cleanup into a suite failure.
    const sweep = (sql: string, params: unknown[]) =>
      getPool()
        .query(sql, params)
        .catch(() => {})

    if (objectNames.length > 0) {
      await sweep(`DELETE FROM storage.objects WHERE name = ANY($1::text[])`, [objectNames])
    }
    await sweep(`DELETE FROM public.company_members WHERE company_id = ANY($1::uuid[])`, [
      [companyA, companyB],
    ])
    await sweep(`DELETE FROM public.companies WHERE id = ANY($1::uuid[])`, [[companyA, companyB]])
    await sweep(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [
      [ownerA, memberA, outsider, exMember],
    ])
  })

  async function visibleNames(userId: string): Promise<string[]> {
    return withUserContext(userId, async (client) => {
      const res = await client.query<{ name: string }>(
        `SELECT name FROM storage.objects WHERE bucket_id = 'documents' AND name = ANY($1::text[])`,
        [objectNames],
      )
      return res.rows.map((r) => r.name)
    })
  }

  describe('policy shape', () => {
    it('the company-scoped policies exist and the Phase A legacy ones are still present', async () => {
      const res = await getPool().query<{ polname: string }>(
        `SELECT polname FROM pg_policy WHERE polrelid = 'storage.objects'::regclass`,
      )
      const names = res.rows.map((r) => r.polname)
      expect(names).toContain('documents_select_company')
      expect(names).toContain('documents_insert_company')
      // Phase A is additive: legacy objects must stay readable until the
      // Phase B backfill reports zero legacy-prefix objects. Phase C drops
      // these two, and only then.
      expect(names).toContain('documents_select_own')
      expect(names).toContain('documents_insert_own')
    })

    it('adds no UPDATE or DELETE policy: WORM semantics stay intact', async () => {
      const res = await getPool().query<{ polcmd: string }>(
        `SELECT polcmd FROM pg_policy
          WHERE polrelid = 'storage.objects'::regclass
            AND polname IN ('documents_select_company', 'documents_insert_company')`,
      )
      // 'r' = SELECT, 'a' = INSERT. Neither 'w' (UPDATE) nor 'd' (DELETE).
      expect(res.rows.map((r) => r.polcmd).sort()).toEqual(['a', 'r'])
    })
  })

  describe('company scoping', () => {
    it('a member of company A can read an object under company A new-layout prefix', async () => {
      const visible = await visibleNames(memberA)
      expect(visible).toContain(keyUploadedByOwner)
      // The point of the fix: a colleague can read underlag they did not
      // upload themselves, because access follows the company, not auth.uid().
      expect(visible).toContain(keyUploadedByExMember)
    })

    it('a non-member cannot read company A objects', async () => {
      const visible = await visibleNames(outsider)
      expect(visible).not.toContain(keyUploadedByOwner)
      expect(visible).not.toContain(keyUploadedByExMember)
      // ... and still sees their own company's object.
      expect(visible).toContain(keyInCompanyB)
    })

    it('a member of A cannot read company B objects', async () => {
      const visible = await visibleNames(memberA)
      expect(visible).not.toContain(keyInCompanyB)
    })

    it('never raises on non-UUID path segments (MCP audit-package keys)', async () => {
      // A `[2]::uuid` cast would raise 22P02 here and fail the whole SELECT
      // instead of filtering the row out, because Postgres does not guarantee
      // the `[1] = 'documents'` qual is evaluated first.
      const visible = await visibleNames(memberA)
      expect(visible).not.toContain(`${ownerA}/audit-packages/1700000000004_archive.zip`)
    })

    it('an insert into another company prefix is rejected', async () => {
      await expect(
        withUserContext(memberA, async (client) => {
          await client.query(
            `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`,
            [`documents/${companyB}/${memberA}/1700000000005_kvitto.pdf`],
          )
        }),
      ).rejects.toThrow(/row-level security/i)
    })

    it('an insert into the own company prefix is accepted', async () => {
      await withUserContext(memberA, async (client) => {
        // withUserContext always rolls back, so this leaves no residue.
        await client.query(
          `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`,
          [`documents/${companyA}/${memberA}/1700000000006_kvitto.pdf`],
        )
      })
    })
  })

  describe('regression: removal from a company revokes storage access', () => {
    it('a user removed from company A loses access to an object they uploaded themselves', async () => {
      // Still a member: they can read their own upload.
      const before = await visibleNames(exMember)
      expect(before).toContain(keyUploadedByExMember)

      await getPool().query(
        `DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
        [companyA, exMember],
      )

      try {
        const after = await visibleNames(exMember)
        // THE bug: under the uploader-scoped policy this still returned the
        // row, because auth.uid() is unchanged and company_members was never
        // consulted. Under the company-scoped policy the membership deletion
        // is what revokes access.
        expect(after).not.toContain(keyUploadedByExMember)
        expect(after).not.toContain(keyUploadedByOwner)
      } finally {
        await insertCompanyMember({ companyId: companyA, userId: exMember, role: 'member' })
      }
    })

    it('a removed member also loses INSERT into the company prefix', async () => {
      await getPool().query(
        `DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
        [companyA, exMember],
      )

      try {
        await expect(
          withUserContext(exMember, async (client) => {
            await client.query(
              `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`,
              [`documents/${companyA}/${exMember}/1700000000007_kvitto.pdf`],
            )
          }),
        ).rejects.toThrow(/row-level security/i)
      } finally {
        await insertCompanyMember({ companyId: companyA, userId: exMember, role: 'member' })
      }
    })
  })

  describe('Phase A coexistence', () => {
    it('legacy uploader-scoped objects stay readable for their uploader', async () => {
      // Until the Phase B backfill has re-homed them, `documents_select_own`
      // is the only thing keeping legacy underlag readable. Phase C must not
      // be applied while this is still true for any object.
      const visible = await visibleNames(ownerA)
      expect(visible).toContain(legacyKey)
    })

    it('legacy objects are NOT readable by a colleague: exactly what Phase B fixes', async () => {
      const visible = await visibleNames(memberA)
      expect(visible).not.toContain(legacyKey)
    })
  })
})
