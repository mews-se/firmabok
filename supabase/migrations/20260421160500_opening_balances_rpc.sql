-- compute_prior_opening_balances(company_id, period_start)
--
-- Server-side aggregate for the opening-balances fallback used when a fiscal
-- period has no opening_balance_entry_id set (i.e. year-end closing never ran
-- for the prior period). Returns one row per balance-sheet account
-- (class 1-2) with the summed debit and credit of every posted/reversed
-- journal line dated before the period start.
--
-- Replaces a paginated PostgREST scan that fetched every prior line via
-- journal_entry_lines with an !inner join on journal_entries. At ~8k lines
-- that scan would tip over the 8s statement_timeout on the authenticated
-- role because the RLS EXISTS subquery on journal_entry_lines re-evaluates
-- user_company_ids() per row on every .range() page. This RPC pushes the
-- filter + SUM into the planner and returns ~50 rows in a single round trip.
--
-- Class 3-8 accounts are intentionally excluded: their balances reset at
-- each year transition and are absorbed into equity via the closing entry;
-- carrying them forward as IB would violate BFNAR 2013:2.
--
-- Duplicate-IB guard: multi-year SIE imports create one opening_balance
-- journal entry per imported year (the #IB records from each SIE file).
-- Each year N+1's IB equals year N's UB, which is already the sum of
-- year N's journal lines — so blindly summing every prior IB double-counts
-- by one year's worth of movements per duplicate. Only the earliest IB per
-- account is kept (pre-system starting capital); later IBs are excluded.

CREATE OR REPLACE FUNCTION compute_prior_opening_balances(
  p_company_id uuid,
  p_period_start date
)
RETURNS TABLE (account_number text, debit numeric, credit numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- Dedup is per-account, not per-entry. If the same account appears in multiple
  -- IB entries (duplicate opening balances from multi-year imports), we keep only
  -- the earliest line for that account. Accounts that appear only in a later IB
  -- (e.g. a new account introduced in year N with no prior-year IB) are still
  -- included — they represent a genuine pre-system starting balance for that
  -- account, not a duplicate.
  WITH ib_lines_ranked AS (
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount,
      ROW_NUMBER() OVER (
        PARTITION BY jel.account_number
        ORDER BY je.entry_date ASC, je.created_at ASC, je.id ASC
      ) AS rn
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status IN ('posted', 'reversed')
      AND je.entry_date < p_period_start
      AND je.source_type = 'opening_balance'
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  earliest_ib AS (
    SELECT account_number, debit_amount, credit_amount
    FROM ib_lines_ranked
    WHERE rn = 1
  ),
  non_ib_lines AS (
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status IN ('posted', 'reversed')
      AND je.entry_date < p_period_start
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  all_lines AS (
    SELECT account_number, debit_amount, credit_amount FROM earliest_ib
    UNION ALL
    SELECT account_number, debit_amount, credit_amount FROM non_ib_lines
  )
  SELECT
    account_number,
    SUM(debit_amount)::numeric  AS debit,
    SUM(credit_amount)::numeric AS credit
  FROM all_lines
  GROUP BY account_number;
$$;

GRANT EXECUTE ON FUNCTION compute_prior_opening_balances(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
