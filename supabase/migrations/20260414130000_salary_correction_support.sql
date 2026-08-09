-- =============================================================================
-- Salary Correction Support
-- =============================================================================
-- Per BFL 5 kap 5§: Corrections must preserve originals via storno entries.
-- Adds 'corrected' status and correction tracking fields to salary_runs.

ALTER TABLE public.salary_runs
  DROP CONSTRAINT IF EXISTS salary_runs_status_check;
ALTER TABLE public.salary_runs
  ADD CONSTRAINT salary_runs_status_check
  CHECK (status IN ('draft', 'review', 'approved', 'paid', 'booked', 'corrected'));

ALTER TABLE public.salary_runs
  ADD COLUMN IF NOT EXISTS is_correction boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS corrects_run_id uuid REFERENCES public.salary_runs(id);

-- Replace unique constraint to allow corrections for the same period.
-- Only one non-corrected run per period per company.
ALTER TABLE public.salary_runs DROP CONSTRAINT IF EXISTS salary_runs_company_id_period_year_period_month_key;
CREATE UNIQUE INDEX idx_salary_runs_period_unique
  ON public.salary_runs (company_id, period_year, period_month)
  WHERE status != 'corrected';

NOTIFY pgrst, 'reload schema';
