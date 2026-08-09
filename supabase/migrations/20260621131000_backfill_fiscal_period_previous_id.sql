-- Backfill fiscal_periods.previous_period_id for periods created without it.
--
-- SIE import (lib/import/sie-import.ts ensureFiscalPeriod) historically inserted
-- fiscal periods without linking previous_period_id, so multi-year imports left
-- the BFNAR 2013:2 continuity chain broken. The resultatrapport prior-period
-- comparison walks that chain to find the prior year — with it null, the
-- comparison column showed only dashes. The balansrapport was unaffected (it
-- sums prior lines via compute_prior_opening_balances, not the chain).
--
-- This sets each period's previous_period_id to the chronologically closest
-- preceding period in the same company. Idempotent: only touches rows where the
-- link is currently NULL, so manually-chained periods are preserved and re-runs
-- are no-ops. No trigger maintains this column (enforce_opening_balance_
-- immutability only guards opening_balance_entry_id / closing_entry_id).
--
-- Guard: only periods that start on the 1st of a month are touched. The
-- enforce_first_of_month_for_subsequent_periods trigger fires BEFORE UPDATE and
-- re-validates period_start, rejecting any period that starts mid-month while an
-- earlier period exists (a legacy/förlängt period that is no longer the
-- chronologically first). Such a row would abort the whole set-based UPDATE.
-- They are rare and left NULL on purpose — generateResultatrapport falls back to
-- the date-adjacent prior period when previous_period_id is null, so the
-- comparison still works for them.

UPDATE public.fiscal_periods AS target
SET previous_period_id = (
  SELECT p.id
  FROM public.fiscal_periods p
  WHERE p.company_id = target.company_id
    AND p.period_end < target.period_start
  ORDER BY p.period_end DESC
  LIMIT 1
)
WHERE target.previous_period_id IS NULL
  AND EXTRACT(DAY FROM target.period_start) = 1
  AND EXISTS (
    SELECT 1
    FROM public.fiscal_periods p2
    WHERE p2.company_id = target.company_id
      AND p2.period_end < target.period_start
  );
