-- Backfill fiscal_periods.opening_balance_entry_id for periods where a SIE
-- import created an opening-balance journal entry but never linked it back to
-- the period. Without the link, getOpeningBalances falls through to summing
-- all prior journal-entry lines before period_start, which double-counts each
-- year's IB against the prior year's UB and inflates balance-sheet accounts
-- in proportion to the number of years imported.
--
-- Safe to re-run: only periods with NULL opening_balance_entry_id are updated.
-- The enforce_opening_balance_immutability trigger (migration 019) only fires
-- when OLD.opening_balance_entry_id IS NOT NULL, so this UPDATE is permitted.
--
-- Periods with more than one posted opening-balance entry (should not happen
-- because checkDuplicatePeriodImport rejects overlapping imports, but a failed
-- partial import could theoretically produce this) are intentionally skipped
-- so the correct entry can be chosen manually rather than linked arbitrarily.

UPDATE public.fiscal_periods fp
SET
  opening_balance_entry_id = (
    SELECT je.id
    FROM public.journal_entries je
    WHERE je.fiscal_period_id = fp.id
      AND je.company_id = fp.company_id
      AND je.source_type = 'opening_balance'
      AND je.status = 'posted'
    LIMIT 1
  ),
  opening_balances_set = true
WHERE fp.opening_balance_entry_id IS NULL
  AND (
    SELECT COUNT(*) FROM public.journal_entries je
    WHERE je.fiscal_period_id = fp.id
      AND je.company_id = fp.company_id
      AND je.source_type = 'opening_balance'
      AND je.status = 'posted'
  ) = 1;
