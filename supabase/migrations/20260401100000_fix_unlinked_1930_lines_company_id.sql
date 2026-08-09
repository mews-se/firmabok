-- Fix get_unlinked_1930_lines to filter by company_id instead of user_id
-- The multi-tenant migration (20260330130000) added company_id to journal_entries
-- and transactions, but this RPC was not updated.

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
