-- Add commit_method and rubric_version columns to journal_entries.
-- Tracks HOW each entry was committed and WHICH rubric was active.
-- Required for autonomous accounting: trust ramp, timing ceiling, audit trail.
--
-- Compliance: BFNAR 2013:2 kap 8 requires behandlingshistorik to log automated
-- processing and user actions. commit_method records this per verifikation.
-- timing_ceiling aligns with BFL 5 kap 2§ (50-day maximum via BFNAR 2013:2).

-- 1. Add columns (nullable — existing rows get NULL)
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS commit_method TEXT CHECK (commit_method IS NULL OR commit_method IN (
    'user_accept', 'bulk_accept', 'timing_ceiling', 'migration', 'legacy'
  )),
  ADD COLUMN IF NOT EXISTS rubric_version TEXT;

-- 2. Update commit RPC to accept and set the new columns atomically
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
  -- Fetch and lock the draft entry
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

  -- Increment voucher sequence (atomic via INSERT ON CONFLICT)
  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  -- Update entry to posted with assigned voucher number and commit metadata.
  -- If the balance trigger (check_balance_on_post) rejects the UPDATE,
  -- the entire transaction rolls back — including the sequence increment.
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

-- 3. Update immutability trigger: include new fields in reversal field check
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  -- Draft can transition to draft (update fields), posted, or cancelled
  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  -- Posted can transition to reversed (storno) or cancelled (orphaned concurrent reversal cleanup)
  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END; $$;

NOTIFY pgrst, 'reload schema';
