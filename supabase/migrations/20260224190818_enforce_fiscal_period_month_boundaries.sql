-- Enforce BFL 3 kap. month boundary rules at the database level.
-- period_start must be the 1st of a month.
-- period_end must be the last day of its month.
-- Using NOT VALID so existing non-conforming rows are not blocked,
-- but all future inserts/updates must comply.

ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_period_start_first_of_month
  CHECK (EXTRACT(DAY FROM period_start) = 1)
  NOT VALID;

ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_period_end_last_of_month
  CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date)
  NOT VALID;
