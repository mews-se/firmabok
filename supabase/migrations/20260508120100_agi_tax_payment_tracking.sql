-- AGI tax payment tracking.
--
-- An AGI declaration represents both the filing obligation and the resulting
-- tax liability for the period (skatt + avgifter). We track when the payment
-- file (Bankgirot LB to BG 5050-1055) was generated and when the payment
-- actually cleared the bank.
--
-- This avoids a separate `tax_payment_runs` table — the AGI declaration is
-- already keyed on (company_id, period_year, period_month) and carries the
-- exact amounts owed.

ALTER TABLE public.agi_declarations
  ADD COLUMN IF NOT EXISTS tax_payment_file_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax_payment_file_format text,
  ADD COLUMN IF NOT EXISTS tax_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax_payment_journal_entry_id uuid REFERENCES public.journal_entries(id);

ALTER TABLE public.agi_declarations
  DROP CONSTRAINT IF EXISTS agi_declarations_tax_payment_format_check;

ALTER TABLE public.agi_declarations
  ADD CONSTRAINT agi_declarations_tax_payment_format_check
  CHECK (tax_payment_file_format IS NULL OR tax_payment_file_format IN ('bg_lb'));

-- Reload PostgREST schema cache so the columns become visible to the API.
NOTIFY pgrst, 'reload schema';
