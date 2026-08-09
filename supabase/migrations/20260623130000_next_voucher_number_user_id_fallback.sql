-- next_voucher_number: fall back to the company owner when auth.uid() is NULL.
--
-- Mirrors 20260421170500 (commit_journal_entry user_id fallback). The same
-- failure mode survived here: under a service-role client (repair scripts,
-- cron, internal maintenance) auth.uid() is NULL, and the INSERT into
-- voucher_sequences fails its user_id NOT NULL check *before* ON CONFLICT
-- can resolve to DO UPDATE (PostgreSQL evaluates NOT NULL on the candidate
-- tuple ahead of conflict arbitration) — even when the sequence row already
-- exists. commit_journal_entry was fixed; the storno/correction path
-- (getNextVoucherNumber → correctEntry) still called this unfixed twin and
-- failed from any non-interactive context.
--
-- next_voucher_number has no journal entry to read attribution from, so the
-- fallback is the company owner (companies.created_by) — same source
-- seed_chart_of_accounts uses. Interactive flows still record auth.uid();
-- existing sequence rows keep their original owner (DO UPDATE never touches
-- user_id).
--
-- Also sets search_path = public: the 20260304 hardening targeted the old
-- (p_user_id …) signature that 20260330 dropped, so the current function had
-- lost it.

CREATE OR REPLACE FUNCTION public.next_voucher_number(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next integer;
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    SELECT created_by INTO v_user_id
    FROM public.companies
    WHERE id = p_company_id;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'next_voucher_number: no attributable user for company %', p_company_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, v_user_id, p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$$;

NOTIFY pgrst, 'reload schema';
