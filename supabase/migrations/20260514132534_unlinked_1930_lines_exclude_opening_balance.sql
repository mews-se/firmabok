-- Exclude opening_balance vouchers from the unmatched-1930 set.
--
-- IB lines (source_type = 'opening_balance', typically created by SIE import
-- or year-end carry-over) post to 1930 on period_start. They have no
-- counterpart in the bank feed by definition — the bank statement starts at
-- IB and accumulates from there. Counting them as "unmatched" produces a
-- phantom voucher in the reconciliation UI and a difference equal to the IB
-- amount, even when every real bank transaction is matched.
--
-- Supersedes the prior definitions in:
--   - supabase/migrations/20240101000030_bank_reconciliation.sql
--   - supabase/migrations/20260401100000_fix_unlinked_1930_lines_company_id.sql
--   - supabase/migrations/20260415000000_schema_sync.sql

DROP FUNCTION IF EXISTS public.get_unlinked_1930_lines(uuid, date, date);

CREATE FUNCTION public.get_unlinked_1930_lines(
  p_company_id UUID,
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL
)
RETURNS TABLE (
  line_id UUID,
  journal_entry_id UUID,
  debit_amount NUMERIC,
  credit_amount NUMERIC,
  line_description TEXT,
  entry_date DATE,
  voucher_number INT,
  voucher_series TEXT,
  entry_description TEXT,
  source_type TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = '1930'
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    -- Unconditional exclusion. By gnubok's data model 'opening_balance' is
    -- reserved for the fiscal-year IB voucher (always posts on period_start);
    -- mid-year corrective entries use 'correction' or 'manual'. So this filter
    -- can't accidentally hide a legitimate mid-period unmatched entry — there
    -- is no such thing as a mid-period opening_balance.
    --
    -- IS DISTINCT FROM is NULL-safe. Today journal_entries.source_type is
    -- NOT NULL, so the only behavioural difference vs `<>` is defensive: if the
    -- NOT NULL constraint is ever relaxed, `<>` would silently drop NULL rows
    -- (NULL <> 'x' evaluates to NULL, not TRUE), making them invisible to
    -- reconciliation. IS DISTINCT FROM treats NULL as a distinct value.
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
