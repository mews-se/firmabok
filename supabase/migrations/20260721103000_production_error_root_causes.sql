-- Repair production error root causes found in the Vercel runtime logs.
--
-- 1. Register the MCP approval event before processing_history references it.
-- 2. Add covering indexes for the two high-volume read paths.
-- 3. Aggregate account balances in Postgres instead of transferring every line.
-- 4. Page VAT source lines in Postgres instead of loading the full result set.

INSERT INTO public.processing_event_types (event_type)
VALUES ('PendingOperationApproved')
ON CONFLICT (event_type) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_audit_log_company_created_id
  ON public.audit_log (company_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_journal_entries_company_posted_date_id
  ON public.journal_entries (company_id, entry_date, id)
  WHERE status IN ('posted', 'reversed');

CREATE OR REPLACE FUNCTION public.get_account_period_activity(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_exclude_journal_entry_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_number text,
  debit numeric,
  credit numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    l.account_number,
    COALESCE(sum(l.debit_amount), 0)::numeric AS debit,
    COALESCE(sum(l.credit_amount), 0)::numeric AS credit
  FROM public.journal_entries je
  JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status IN ('posted', 'reversed')
    AND je.entry_date >= p_start
    AND je.entry_date <= p_end
    AND l.account_number = ANY (p_accounts)
    AND (
      p_exclude_journal_entry_id IS NULL
      OR je.id <> p_exclude_journal_entry_id
    )
  GROUP BY l.account_number
  ORDER BY l.account_number;
$$;

REVOKE ALL ON FUNCTION public.get_account_period_activity(uuid, date, date, text[], uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_period_activity(uuid, date, date, text[], uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_vat_ruta_source_lines(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_cursor_date date DEFAULT NULL,
  p_cursor_voucher_number integer DEFAULT NULL,
  p_cursor_entry_id uuid DEFAULT NULL,
  p_cursor_line_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 501
)
RETURNS TABLE (
  line_id uuid,
  journal_entry_id uuid,
  voucher_number integer,
  voucher_series text,
  entry_date date,
  description text,
  debit_amount numeric,
  credit_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    l.id AS line_id,
    je.id AS journal_entry_id,
    je.voucher_number,
    COALESCE(je.voucher_series, 'A') AS voucher_series,
    je.entry_date,
    COALESCE(je.description, '') AS description,
    l.debit_amount,
    l.credit_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status IN ('posted', 'reversed')
    AND je.entry_date >= p_start
    AND je.entry_date <= p_end
    AND l.account_number = ANY (p_accounts)
    AND (
      p_cursor_date IS NULL
      OR (
        je.entry_date,
        je.voucher_number,
        je.id,
        l.id
      ) > (
        p_cursor_date,
        p_cursor_voucher_number,
        COALESCE(p_cursor_entry_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),
        COALESCE(p_cursor_line_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      )
    )
  ORDER BY je.entry_date, je.voucher_number, je.id, l.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 501), 1), 501);
$$;

REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
