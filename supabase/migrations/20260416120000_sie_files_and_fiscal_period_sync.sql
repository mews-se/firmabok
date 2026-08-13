-- Restore the fiscal_periods trigger that only lets the FIRST period start
-- mid-month (originally 20260409165300), lost in the PR #244 consolidation.
--
-- The section is idempotent so re-applying is safe on existing installs and
-- on fresh ones.
--
-- Fixes: fresh DBs had no equivalent of the non-first-of-month trigger, so
-- local tests didn't catch the constraint that bit users.

-- =============================================================================
-- fiscal_periods: only the first period per company may start mid-month
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
