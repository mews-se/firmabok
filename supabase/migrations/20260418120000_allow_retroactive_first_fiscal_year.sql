-- Allow retroactive first fiscal year via SIE import.
--
-- The previous trigger (20260416120000) rejected any non-first-of-month
-- period_start when *any other* fiscal period existed for the company.
-- That blocked a common flow: user onboards and gets a default period
-- (e.g. the current year, starting on day 1), then imports an SIE file
-- covering an older, förlängt första räkenskapsår that starts mid-month
-- (e.g. 2017-07-28 – 2018-12-31).
--
-- Per BFL 3 kap., the forst-in-time (chronologically earliest) fiscal year
-- is the one that may be 6–18 months and start mid-month. That property is
-- about *when* the period starts relative to other periods, not about the
-- order rows were inserted. This migration changes the trigger to reflect
-- that: mid-month start is allowed iff no existing period starts earlier.

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
