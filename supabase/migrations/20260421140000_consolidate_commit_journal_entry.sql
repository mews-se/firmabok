-- Consolidate commit_journal_entry to a single 4-argument signature with defaults.
--
-- History:
--  - 20260402100200 created the canonical 2-arg (p_company_id, p_entry_id) version.
--  - journal_entry_commit_metadata added commit_method + rubric_version columns and
--    created a 4-arg overload via CREATE OR REPLACE; because the signature differs
--    from the 2-arg, both versions coexisted in prod, producing the
--    "Could not choose the best candidate function" ambiguity error on 2-arg calls.
--
-- Final state after this migration: only the 4-arg-with-defaults signature remains.
-- Callable with either 2 or 4 named args (defaults fill in the rest), so both the
-- currently-deployed 2-arg caller and the post-commit-metadata 4-arg caller work.
--
-- Idempotent: safe on any of the possible prior states (both, 2-arg only,
-- or 4-arg only). Columns commit_method / rubric_version are assumed to exist
-- (created earlier in the journal_entry_commit_metadata migration).

DROP FUNCTION IF EXISTS public.commit_journal_entry(uuid, uuid);

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
BEGIN
  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A')
  INTO v_fiscal_period_id, v_series
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), v_fiscal_period_id, v_series, 1)
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
