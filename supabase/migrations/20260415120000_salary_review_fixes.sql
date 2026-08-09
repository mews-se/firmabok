-- =============================================================================
-- Fix 1: Add pension_entry_id to salary_runs
-- Pension journal entries from löneväxling were created but never stored,
-- causing them to be missed during correction reversals.
-- =============================================================================

ALTER TABLE public.salary_runs
  ADD COLUMN pension_entry_id uuid REFERENCES public.journal_entries(id);

-- =============================================================================
-- Fix 2: Add UNIQUE constraint on employees(company_id, specification_number)
-- Prevents duplicate FK570 specification numbers from concurrent inserts.
-- The assign_specification_number trigger uses SELECT MAX() without locking,
-- so this constraint makes any race condition fail explicitly.
-- =============================================================================

ALTER TABLE public.employees
  ADD CONSTRAINT employees_company_spec_number_unique
  UNIQUE (company_id, specification_number);

-- =============================================================================
-- Fix 3: Add avgifter_category to salary_run_employees
-- The avgifter rate alone cannot distinguish between reduced_65plus and
-- vaxa_stod (both 10.21% in 2026). Store the category from the calculation
-- engine so AGI XML generation uses the correct HU rutor breakdown.
-- =============================================================================

ALTER TABLE public.salary_run_employees
  ADD COLUMN avgifter_category text
  CHECK (avgifter_category IN ('standard', 'reduced_65plus', 'youth', 'vaxa_stod', 'exempt'));

-- Schema reload for PostgREST
NOTIFY pgrst, 'reload schema';
