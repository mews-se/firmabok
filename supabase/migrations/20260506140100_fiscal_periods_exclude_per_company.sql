-- Fix multi-tenant gap in fiscal_periods.no_overlapping_fiscal_periods
--
-- The exclusion constraint was created before multi-tenant and scopes
-- overlap detection by user_id. After the multi-tenant refactor a single
-- user can own/be a member of multiple companies, which legitimately
-- have their own (overlapping) fiscal years. Rebind the exclusion to
-- company_id so the constraint reflects per-tenant uniqueness.

ALTER TABLE public.fiscal_periods
  DROP CONSTRAINT IF EXISTS no_overlapping_fiscal_periods;

ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT no_overlapping_fiscal_periods
  EXCLUDE USING gist (
    company_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  );

NOTIFY pgrst, 'reload schema';
