-- Restore retroactive first fiscal year fix.
--
-- Migration 20260418120000 (applied to prod as 20260420092940
-- "allow_retroactive_first_fiscal_year") relaxed the trigger so that a
-- mid-month period_start is allowed when no existing period starts earlier.
--
-- However, on prod the migration "sie_files_and_fiscal_period_sync" was
-- recorded with version 20260421194554 — *after* the fix — and its body
-- contains a CREATE OR REPLACE FUNCTION with the strict pre-fix logic,
-- which clobbered the relaxed trigger. As a result the SIE import flow
-- for förlängt första räkenskapsår started failing again on prod.
--
-- This migration re-applies the relaxed trigger so that mid-month start
-- is allowed iff no existing period starts earlier.

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
      AND period_start < NEW.period_start
  ) THEN
    RAISE EXCEPTION 'Non-first fiscal period must start on the 1st of a month';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
