-- Documents bucket: company-scoped storage policies (PHASE A of 3)
--
-- PROBLEM
-- 20240101000024_storage_bucket_policies.sql scoped the `documents` bucket on
-- the UPLOADER, not on the tenant:
--
--   (storage.foldername(name))[1] = 'documents'
--   AND (storage.foldername(name))[2] = auth.uid()::text
--
-- company_id appears nowhere in the policy, and nowhere in the storage key
-- (`documents/{userId}/{timestamp}_{filename}`). Removing a member from a
-- company deletes their company_members row, but the storage policy never
-- consulted company_members: auth.uid() is unchanged, so the ex-member keeps
-- direct Supabase Storage read access to every kvitto, leverantorsfaktura and
-- bank statement they ever uploaded. That is a GDPR Art. 32 access-control
-- failure over records held under the BFL 7 kap 2 § seven-year retention
-- requirement.
--
-- The identical bug was already fixed for the `sie-files` bucket in
-- 20260416120000_sie_files_and_fiscal_period_sync.sql; this migration follows
-- that precedent.
--
-- THREE-PHASE ROLLOUT
--   Phase A (THIS MIGRATION, additive and reversible):
--     * add company-scoped policies for the NEW key layout
--       `documents/{companyId}/{userId}/{timestamp}_{filename}`
--     * leave `documents_insert_own` / `documents_select_own` in place, so
--       legacy `documents/{userId}/...` objects stay readable
--     * the application write path switches to the new layout immediately,
--       so every NEW upload is correctly scoped from this migration onward
--   Phase B (data): run scripts/backfill-document-storage-paths.ts against
--     staging, then production. It copies each legacy object to its
--     company-scoped key, verifies the copy is readable, updates
--     document_attachments.storage_path, and only then removes the source.
--   Phase C (cleanup, a SEPARATE migration, NOT part of this change):
--     drop `documents_insert_own` and `documents_select_own`. Phase C is
--     GATED on the Phase B backfill reporting ZERO remaining objects under
--     the legacy `documents/{userId}/...` prefix. Dropping the uploader-scoped
--     policies while legacy-prefix objects remain makes those documents
--     unreadable to everyone except the service role, which would break
--     underlag preview, the integrity cron, and the archive export.
--
-- Idempotent: safe to re-apply on prod, staging, preview branches, and fresh
-- installs.

-- =============================================================================
-- 1. Bucket exists (no-op when 20240101000024 already created it)
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  52428800, -- 50 MB
  NULL      -- all MIME types; the application layer validates
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. Company-scoped policies for the new layout
--
--    documents/{companyId}/{userId}/{timestamp}_{filename}
--    segment [1] = 'documents', [2] = companyId, [3] = uploader userId
--
-- Deliberate deviation from the sie-files precedent: that policy casts the
-- path segment with `(storage.foldername(name))[1]::uuid`. The documents
-- bucket cannot do that. It holds keys whose second segment is NOT a UUID
-- (the MCP audit-package tool writes `{userId}/audit-packages/{ts}_{name}`),
-- and Postgres does not guarantee that the `[1] = 'documents'` qual is
-- evaluated before the cast: a planner reordering would raise
-- `invalid input syntax for type uuid` and fail the whole query instead of
-- filtering the row out. Comparing as text is exact for canonical lowercase
-- UUIDs (which is what Postgres emits and what the application writes) and
-- can never raise.
--
-- INSERT is scoped to company membership only, not to
-- `[3] = auth.uid()::text`. Several legitimate write paths upload on behalf
-- of another member (inbound e-post inbox, bank sync, Bolagsverket
-- submission); they run under the service role today, and pinning the third
-- segment would silently break them the moment any of them moves to a
-- user-scoped client. The tenant boundary is the control that was missing.
--
-- No UPDATE and no DELETE policy: WORM semantics for BFL 7 kap retention,
-- matching both 20240101000024 and the sie-files precedent. The service role
-- bypasses RLS for admin, cron and backfill work.
-- =============================================================================

DROP POLICY IF EXISTS documents_select_company ON storage.objects;
DROP POLICY IF EXISTS documents_insert_company ON storage.objects;

CREATE POLICY documents_select_company
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'documents'
    AND (storage.foldername(name))[2] IN (
      SELECT cid::text FROM public.user_company_ids() AS cid
    )
  );

CREATE POLICY documents_insert_company
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'documents'
    AND (storage.foldername(name))[2] IN (
      SELECT cid::text FROM public.user_company_ids() AS cid
    )
  );

-- =============================================================================
-- 3. NOT DONE HERE (Phase C, separate migration, gated on the backfill):
--
--   DROP POLICY IF EXISTS "documents_insert_own" ON storage.objects;
--   DROP POLICY IF EXISTS "documents_select_own" ON storage.objects;
--
-- Do not run those until scripts/backfill-document-storage-paths.ts reports
-- zero objects remaining under the legacy `documents/{userId}/...` prefix.
-- =============================================================================

NOTIFY pgrst, 'reload schema';
