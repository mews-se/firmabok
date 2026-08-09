-- Migration 19: Fiscal Period Closing Metadata
-- Adds columns for year-end closing workflow and opening balance tracking

-- =============================================================================
-- 1. Add closing_entry_id — tracks which journal entry closed this period
-- =============================================================================
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS closing_entry_id uuid REFERENCES public.journal_entries(id);

-- =============================================================================
-- 2. Add opening_balance_entry_id — tracks which entry set opening balances
-- =============================================================================
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS opening_balance_entry_id uuid REFERENCES public.journal_entries(id);

-- =============================================================================
-- 3. Add previous_period_id — chain validation link
-- =============================================================================
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS previous_period_id uuid REFERENCES public.fiscal_periods(id);

-- =============================================================================
-- 4. Trigger: block modification of opening balance entries
-- Once a fiscal period has opening_balance_entry_id set and the entry is posted,
-- the opening_balance_entry_id cannot be changed.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_opening_balance_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only check if opening_balance_entry_id is being changed
  IF OLD.opening_balance_entry_id IS NOT NULL
     AND OLD.opening_balances_set = true
     AND NEW.opening_balance_entry_id IS DISTINCT FROM OLD.opening_balance_entry_id THEN
    RAISE EXCEPTION 'Cannot modify opening_balance_entry_id on period "%" — opening balances are immutable once set',
      OLD.name;
  END IF;

  -- Also block changing closing_entry_id once set
  IF OLD.closing_entry_id IS NOT NULL
     AND NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id THEN
    RAISE EXCEPTION 'Cannot modify closing_entry_id on period "%" — year-end closing is immutable',
      OLD.name;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_opening_balance_immutability
  BEFORE UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opening_balance_immutability();

-- Indexes for the new FK columns
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_closing_entry ON public.fiscal_periods (closing_entry_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_opening_balance_entry ON public.fiscal_periods (opening_balance_entry_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_previous_period ON public.fiscal_periods (previous_period_id);
