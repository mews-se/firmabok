-- compute_prior_opening_balances — correctness fixes
--
-- Supersedes the function defined in 20260421160000. Addresses two bugs
-- surfaced in Swedish accounting compliance review:
--
-- 1. Reversed entries were previously included in ib_lines_ranked via
--    status IN ('posted', 'reversed'). Because the per-account ROW_NUMBER
--    dedup picks the earliest IB line (rn = 1), a cancelled (reversed) IB
--    could be carried forward as the pre-system starting balance while its
--    matching storno entry (source_type = 'storno') landed in non_ib_lines
--    with flipped amounts — producing a net negative skew equal to the
--    cancelled IB. Now ib_lines_ranked only considers currently-posted IB
--    entries, and non_ib_lines excludes 'storno' source_type so a cancelled
--    pair contributes zero on both sides. Per BFL 5:5, the computed IB must
--    reflect the legally effective net position, not a cancelled entry.
--
-- 2. The per-account dedup rule ("keep earliest IB line, drop the rest")
--    double-counted balances for accounts that first appeared in a later
--    year's IB but already had prior-year non-IB activity. In a multi-year
--    SIE import, a year-N IB line equals year-(N-1) UB, which is already
--    captured in the prior-year transaction lines. The correct rule is:
--    keep the earliest IB line for an account only if there is no non-IB
--    activity on that account dated before the IB itself. Otherwise the
--    IB is a restatement of a UB already derivable from non-IB lines.
--    This preserves genuine pre-system starting balances for accounts
--    introduced later (BFNAR 2013:2) while preventing phantom balances.

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
  WITH ib_lines_ranked AS (
    -- Currently-effective IB lines only. Reversed originals and their stornos
    -- are both excluded (originals by status, stornos by source_type below).
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount,
      je.entry_date,
      ROW_NUMBER() OVER (
        PARTITION BY jel.account_number
        ORDER BY je.entry_date ASC, je.created_at ASC, je.id ASC
      ) AS rn
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.entry_date < p_period_start
      AND je.source_type = 'opening_balance'
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  earliest_ib AS (
    SELECT account_number, debit_amount, credit_amount, entry_date
    FROM ib_lines_ranked
    WHERE rn = 1
  ),
  non_ib_lines AS (
    -- Non-IB, non-storno posted lines. Excluding source_type = 'storno'
    -- pairs with the status = 'posted' filter on reversed originals so a
    -- cancelled entry contributes zero on both sides. Regular posted
    -- transactions contribute their amounts.
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount,
      je.entry_date
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.entry_date < p_period_start
      AND je.source_type NOT IN ('opening_balance', 'storno')
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  effective_ib AS (
    -- Keep earliest IB for an account only if no non-IB activity predates it.
    -- A later-year IB for an account with prior-year transactions is just a
    -- restatement of the prior UB — already summed in non_ib_lines.
    SELECT eib.account_number, eib.debit_amount, eib.credit_amount
    FROM earliest_ib eib
    WHERE NOT EXISTS (
      SELECT 1
      FROM non_ib_lines nil
      WHERE nil.account_number = eib.account_number
        AND nil.entry_date < eib.entry_date
    )
  ),
  all_lines AS (
    SELECT account_number, debit_amount, credit_amount FROM effective_ib
    UNION ALL
    SELECT account_number, debit_amount, credit_amount
    FROM non_ib_lines
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
