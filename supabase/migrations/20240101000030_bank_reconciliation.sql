-- Bank reconciliation support
-- Adds reconciliation_method to transactions, indexes for fast lookups,
-- and an RPC function to find unlinked 1930 journal entry lines.

-- Add reconciliation_method column to transactions
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reconciliation_method TEXT
  CHECK (reconciliation_method IN (
    'auto_exact', 'auto_date_range', 'auto_reference', 'auto_fuzzy', 'manual'
  ));

-- Index for fast lookup of unreconciled transactions (no journal entry linked)
CREATE INDEX IF NOT EXISTS idx_transactions_unmatched
  ON public.transactions (user_id, date)
  WHERE journal_entry_id IS NULL;

-- Index for fast lookup of bank account GL lines
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_1930
  ON public.journal_entry_lines (account_number, journal_entry_id)
  WHERE account_number = '1930';

-- RPC function: returns posted journal entry lines on account 1930
-- that have no linked transaction (i.e., unreconciled GL lines).
CREATE OR REPLACE FUNCTION public.get_unlinked_1930_lines(
  p_user_id UUID,
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
    AND je.user_id = p_user_id
    AND je.status = 'posted'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.user_id = p_user_id
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;
