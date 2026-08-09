-- Add 'cancelled' status to journal entries for BFL varaktighet compliance.
-- Once a row is inserted into journal_entries, it must remain traceable.
-- Application code uses status='cancelled' instead of DELETE.

-- 1. Expand status CHECK to include 'cancelled'
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_status_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_status_check
  CHECK (status IN ('draft', 'posted', 'reversed', 'cancelled'));

-- 2. Update immutability trigger: block all DELETEs, allow draft->cancelled
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- No exemption for drafts: varaktighet applies from insertion.
    -- Application code uses status='cancelled' instead of DELETE.
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
         OR NEW.voucher_number != OLD.voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END; $$;

-- 3. Update line immutability: allow operations on cancelled parent entries
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Draft entries: all operations allowed
  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Cancelled entries: only DELETE for cleanup
  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $$;
