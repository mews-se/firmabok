-- Allow re-importing an SIE file after the previous import was undone.
--
-- 20260528120100_undo_sie_import.sql added the 'undone' status but did not
-- touch the partial unique index from 20260517150000, which excludes only
-- 'replaced' and 'failed'. Result: after undo_sie_import flips a row to
-- 'undone', the (company_id, file_hash) slot is still held and a fresh
-- upload of the same file fails with sie_imports_company_id_file_hash_key.
--
-- This migration also catches databases (e.g. staging) where
-- 20260517150000 was never applied — they still carry the plain UNIQUE
-- constraint. All operations are idempotent: dropping non-existent
-- constraints/indexes is a no-op, and CREATE INDEX IF NOT EXISTS skips
-- when the partial index already exists from a prior run.

ALTER TABLE public.sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_company_id_file_hash_key;

DROP INDEX IF EXISTS public.sie_imports_company_id_file_hash_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS sie_imports_company_id_file_hash_active_idx
  ON public.sie_imports (company_id, file_hash)
  WHERE status <> ALL (ARRAY['replaced'::text, 'failed'::text, 'undone'::text]);

NOTIFY pgrst, 'reload schema';
