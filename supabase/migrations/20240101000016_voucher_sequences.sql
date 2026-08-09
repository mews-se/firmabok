-- Migration 16: Voucher Sequence Hardening
-- Concurrent-safe voucher numbering and balance constraint

-- =============================================================================
-- 1. voucher_sequences table
-- =============================================================================
CREATE TABLE public.voucher_sequences (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  fiscal_period_id uuid REFERENCES public.fiscal_periods(id) ON DELETE CASCADE NOT NULL,
  voucher_series   text NOT NULL DEFAULT 'A',
  last_number      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, fiscal_period_id, voucher_series)
);

ALTER TABLE public.voucher_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voucher_sequences_select" ON public.voucher_sequences
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "voucher_sequences_insert" ON public.voucher_sequences
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "voucher_sequences_update" ON public.voucher_sequences
  FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER voucher_sequences_updated_at
  BEFORE UPDATE ON public.voucher_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. Replace next_voucher_number() with concurrent-safe version
-- Uses INSERT ON CONFLICT + UPDATE RETURNING for row-level locking
-- =============================================================================
CREATE OR REPLACE FUNCTION public.next_voucher_number(
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
BEGIN
  -- INSERT or UPDATE with row-level lock (prevents race conditions)
  INSERT INTO public.voucher_sequences (user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_user_id, p_fiscal_period_id, p_series, 1)
  ON CONFLICT (user_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$$;

-- =============================================================================
-- 3. Balance constraint trigger for posted entries
-- Validates debit == credit (DEFERRABLE to allow batch line inserts)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.check_journal_entry_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_debit  numeric;
  v_total_credit numeric;
  v_status       text;
  v_entry_id     uuid;
BEGIN
  -- Determine the entry ID based on trigger context
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry_id := NEW.id;
    v_status := NEW.status;
  ELSE
    v_entry_id := NEW.journal_entry_id;
    SELECT status INTO v_status
    FROM public.journal_entries
    WHERE id = v_entry_id;
  END IF;

  -- Only enforce on posted entries
  IF v_status != 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
  INTO v_total_debit, v_total_credit
  FROM public.journal_entry_lines
  WHERE journal_entry_id = v_entry_id;

  IF ROUND(v_total_debit, 2) != ROUND(v_total_credit, 2) THEN
    RAISE EXCEPTION 'Journal entry % is not balanced: debit=% credit=%',
      v_entry_id, v_total_debit, v_total_credit;
  END IF;

  IF v_total_debit = 0 THEN
    RAISE EXCEPTION 'Journal entry % has zero total', v_entry_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Apply as DEFERRABLE constraint trigger on journal_entries status change
CREATE CONSTRAINT TRIGGER check_balance_on_post
  AFTER UPDATE ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'posted' AND OLD.status = 'draft')
  EXECUTE FUNCTION public.check_journal_entry_balance();

-- =============================================================================
-- 4. Function to detect voucher gaps for compliance reporting
-- =============================================================================
CREATE OR REPLACE FUNCTION public.detect_voucher_gaps(
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'
)
RETURNS TABLE (
  gap_start integer,
  gap_end integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH numbered AS (
    SELECT voucher_number,
           LEAD(voucher_number) OVER (ORDER BY voucher_number) AS next_number
    FROM public.journal_entries
    WHERE user_id = p_user_id
      AND fiscal_period_id = p_fiscal_period_id
      AND voucher_series = p_series
      AND status != 'draft'
    ORDER BY voucher_number
  )
  SELECT
    voucher_number + 1 AS gap_start,
    next_number - 1 AS gap_end
  FROM numbered
  WHERE next_number IS NOT NULL
    AND next_number > voucher_number + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_voucher_gaps(uuid, uuid, text) TO authenticated;
