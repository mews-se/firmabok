-- Salary payment files: Bankgirot LB-fil support alongside existing pain.001 (SEPA).
--
-- Most Swedish SMBs upload Bankgirot LB-files to Swedbank/SEB/Handelsbanken/Nordea
-- via their corporate portal — pain.001 is also supported but less common.
--
-- This migration:
--   1. Adds `preferred_payment_format` to `company_settings` so the UI can
--      pre-select the right format per company.
--   2. Tracks which format was generated for each salary run, plus the
--      generation timestamp (used by deadline reminders).

-- ------------------------------------------------------------------
-- company_settings.preferred_payment_format
-- ------------------------------------------------------------------
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS preferred_payment_format text NOT NULL DEFAULT 'bg_lb';

-- Re-apply default + NOT NULL in case ADD COLUMN IF NOT EXISTS skipped them
-- (column existed out-of-band).
ALTER TABLE public.company_settings
  ALTER COLUMN preferred_payment_format SET DEFAULT 'bg_lb';

UPDATE public.company_settings
  SET preferred_payment_format = 'bg_lb'
  WHERE preferred_payment_format IS NULL;

ALTER TABLE public.company_settings
  ALTER COLUMN preferred_payment_format SET NOT NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_preferred_payment_format_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_preferred_payment_format_check
  CHECK (preferred_payment_format IN ('bg_lb', 'pain001'));

-- ------------------------------------------------------------------
-- salary_runs payment file tracking
-- ------------------------------------------------------------------
ALTER TABLE public.salary_runs
  ADD COLUMN IF NOT EXISTS payment_file_format text,
  ADD COLUMN IF NOT EXISTS payment_file_generated_at timestamptz;

ALTER TABLE public.salary_runs
  DROP CONSTRAINT IF EXISTS salary_runs_payment_file_format_check;

ALTER TABLE public.salary_runs
  ADD CONSTRAINT salary_runs_payment_file_format_check
  CHECK (payment_file_format IS NULL OR payment_file_format IN ('bg_lb', 'pain001'));

-- Reload PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
