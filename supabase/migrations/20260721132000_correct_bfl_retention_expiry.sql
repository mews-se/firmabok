-- BFL 7 kap. 2 § requires accounting information to be preserved through
-- the end of the seventh calendar year after the calendar year in which the
-- fiscal year ended. retention_expires_at stores the first date on which the
-- statutory minimum retention period has elapsed.

CREATE OR REPLACE FUNCTION public.set_bfl_retention_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.retention_expires_at := make_date(
    extract(year FROM NEW.period_end)::integer + 8,
    1,
    1
  );
  RETURN NEW;
END;
$$;

-- PostgreSQL fires triggers with the same timing alphabetically. The zz
-- prefix makes this legal correction run after the original migration 017
-- trigger without modifying that shipped enforcement migration. It must run
-- on every update because the original calculate_retention_expiry trigger also
-- runs on every update and would otherwise restore the old, too-early date.
DROP TRIGGER IF EXISTS zz_set_bfl_retention_expiry ON public.fiscal_periods;

CREATE TRIGGER zz_set_bfl_retention_expiry
  BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_bfl_retention_expiry();

-- The period-start validator depends only on company_id and period_start.
-- Restrict UPDATE execution to those columns so retention and other metadata
-- backfills do not revalidate unchanged historical period dates.
DROP TRIGGER IF EXISTS enforce_period_start_day ON public.fiscal_periods;

CREATE TRIGGER enforce_period_start_day
  BEFORE INSERT OR UPDATE OF company_id, period_start ON public.fiscal_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_first_of_month_for_subsequent_periods();

UPDATE public.fiscal_periods
SET retention_expires_at = make_date(
  extract(year FROM period_end)::integer + 8,
  1,
  1
)
WHERE retention_expires_at IS DISTINCT FROM make_date(
  extract(year FROM period_end)::integer + 8,
  1,
  1
);

NOTIFY pgrst, 'reload schema';
