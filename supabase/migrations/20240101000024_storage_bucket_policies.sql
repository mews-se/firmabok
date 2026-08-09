-- Migration 24: Storage Bucket Policies for WORM Document Archive
-- Resolves: Gap 3 (no immutability on Storage level)
--
-- Creates a private 'documents' bucket with:
-- - INSERT policy (authenticated users upload to their own folder)
-- - SELECT policy (authenticated users read their own documents)
-- - NO UPDATE policy (prevents overwriting files — WORM)
-- - NO DELETE policy (prevents client-side deletion — WORM)
--
-- Service role (cron, admin) bypasses RLS and can still access everything.

-- =============================================================================
-- 1. Create the 'documents' bucket (private, 50MB file limit)
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  52428800, -- 50 MB
  NULL      -- Allow all MIME types (PDFs, images, etc.)
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. INSERT policy: Authenticated users can upload to their own folder
-- =============================================================================

CREATE POLICY "documents_insert_own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- =============================================================================
-- 3. SELECT policy: Authenticated users can read their own documents
-- =============================================================================

CREATE POLICY "documents_select_own"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- =============================================================================
-- No UPDATE or DELETE policies — WORM compliance
-- Service role bypasses RLS for admin/cron access
-- =============================================================================
