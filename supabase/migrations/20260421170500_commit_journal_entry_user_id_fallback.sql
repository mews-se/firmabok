-- commit_journal_entry: fall back to the draft entry's user_id when
-- auth.uid() is NULL.
--
-- Context: when this RPC is invoked via the service role (one-off repair
-- scripts, cron jobs, internal maintenance flows), auth.uid() returns NULL.
-- The INSERT into voucher_sequences then fails its user_id NOT NULL check
-- *before* ON CONFLICT can resolve to DO UPDATE (PostgreSQL evaluates NOT
-- NULL on the candidate tuple ahead of conflict arbitration). That made it
-- impossible to commit journal entries from any non-interactive context.
--
-- Fix: read user_id from the draft journal entry (which is always set by
-- createJournalEntry) and use it as the fallback attribution on the
-- voucher sequence row. Normal interactive flows still record auth.uid();
-- only the service-role path changes.

CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL,
  p_rubric_version text DEFAULT NULL
)
RETURNS TABLE (voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$$;

NOTIFY pgrst, 'reload schema';
