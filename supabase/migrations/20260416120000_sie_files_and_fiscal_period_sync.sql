-- Sync two schema objects that production carries but the repo lost
-- in the PR #244 consolidation:
--   1. sie-files storage bucket + RLS policies (originally 20260408130000)
--   2. fiscal_periods trigger that only lets the FIRST period start mid-month
--      (originally 20260409165300)
--
-- Both sections are idempotent so re-applying is safe on prod, staging,
-- preview branches, and fresh installs.
--
-- Fixes:
--   - Archive upload fails with "new row violates row-level security policy"
--     because prod policies still required the path to start with auth.uid(),
--     but the code (post multi-tenant refactor 1534979) uploads to
--     {company_id}/{import_id}.se. New policies scope access to every member
--     of the company that owns the path prefix.
--   - Fresh/preview DBs had no equivalent of the non-first-of-month trigger,
--     so local tests didn't catch the constraint that bit prod users.

-- =============================================================================
-- 1. sie-files bucket
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sie-files',
  'sie-files',
  false,
  52428800, -- 50 MB, matches MAX_FILE_SIZE in the SIE parse route
  ARRAY['text/plain', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Drop the legacy user_id-scoped policies (pre multi-tenant refactor).
DROP POLICY IF EXISTS "Users can upload SIE files to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can read own SIE files" ON storage.objects;

-- Drop the names used by this migration in case it's re-applied.
DROP POLICY IF EXISTS sie_files_insert ON storage.objects;
DROP POLICY IF EXISTS sie_files_select ON storage.objects;

CREATE POLICY sie_files_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'sie-files'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.user_company_ids())
  );

CREATE POLICY sie_files_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'sie-files'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.user_company_ids())
  );

-- No UPDATE or DELETE policies — WORM semantics for BFL 7 kap. retention.
-- Service role bypasses RLS for admin/cron cleanup.

-- =============================================================================
-- 2. fiscal_periods: only the first period per company may start mid-month
-- =============================================================================

-- Drop the old unconditional CHECK constraint if it's still around from
-- 20260224190818 (it was superseded by the trigger in prod but may still
-- exist on fresh installs that replayed the early migrations).
ALTER TABLE public.fiscal_periods
  DROP CONSTRAINT IF EXISTS fiscal_period_start_first_of_month;

CREATE OR REPLACE FUNCTION public.enforce_first_of_month_for_subsequent_periods()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXTRACT(DAY FROM NEW.period_start) = 1 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods
    WHERE company_id = NEW.company_id
      AND id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'Non-first fiscal period must start on the 1st of a month';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_period_start_day ON public.fiscal_periods;

CREATE TRIGGER enforce_period_start_day
  BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_first_of_month_for_subsequent_periods();

NOTIFY pgrst, 'reload schema';
