-- Capture the partial unique index on sie_imports that already exists in
-- production but was never expressed as a repo migration (schema drift).
--
-- The plain UNIQUE (company_id, file_hash) constraint added in
-- 20260330130000_multi_tenant_company_refactor.sql blocks a fiscal-year
-- re-sync from Fortnox: the prior 'completed' row keeps the slot even
-- though we want a new import to take its place (with the old one marked
-- 'replaced'). The partial index relaxes uniqueness for 'replaced' and
-- 'failed' rows so a replace-and-reimport works.
--
-- Both statements are idempotent. Against production this migration is a
-- no-op; on dev/staging databases that still carry the plain constraint
-- it brings them in line.

CREATE UNIQUE INDEX IF NOT EXISTS sie_imports_company_id_file_hash_active_idx
  ON public.sie_imports (company_id, file_hash)
  WHERE status <> ALL (ARRAY['replaced'::text, 'failed'::text]);

ALTER TABLE public.sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_company_id_file_hash_key;

NOTIFY pgrst, 'reload schema';
