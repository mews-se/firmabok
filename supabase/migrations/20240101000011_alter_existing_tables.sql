-- Migration 11: ALTER Existing Tables
-- Add compliance-critical columns to chart_of_accounts, journal_entries,
-- journal_entry_lines, and fiscal_periods

-- =============================================================================
-- 1. chart_of_accounts: Add SRU code for Skatteverket tax filing
-- =============================================================================
ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS sru_code text;

-- =============================================================================
-- 2. journal_entries: Add compliance columns
-- =============================================================================

-- Track when draft became posted
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS committed_at timestamptz;

-- Link to storno entry that reversed this
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS reversed_by_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Link to entry this storno reverses
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS reverses_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Link to original in correction chain
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS correction_of_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Expand source_type CHECK to include storno, correction, import, system
-- First drop the existing check constraint, then re-add with expanded values
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system'
  ));

-- Indexes for the new FK columns
CREATE INDEX IF NOT EXISTS idx_journal_entries_reversed_by_id ON public.journal_entries (reversed_by_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reverses_id ON public.journal_entries (reverses_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_correction_of_id ON public.journal_entries (correction_of_id);

-- =============================================================================
-- 3. journal_entry_lines: Add dimension columns
-- =============================================================================

-- Decoupled tax code reference
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS tax_code text;

-- Kostnadsställe dimension
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS cost_center text;

-- Projekt dimension
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS project text;

-- Note: idx_journal_entry_lines_cost_center and idx_journal_entry_lines_project
-- are created by migration 015 (dimensions) on the UUID FK columns (cost_center_id, project_id).
-- The text dimension columns (cost_center, project) are supplementary and don't need separate indexes.
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_tax_code ON public.journal_entry_lines (tax_code) WHERE (tax_code IS NOT NULL);

-- =============================================================================
-- 4. fiscal_periods: Add lock and retention columns
-- =============================================================================

-- Period lock timestamp (separate from is_closed)
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Auto-calculated: period_end + 7 years
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS retention_expires_at date;
