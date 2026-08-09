-- Add accounting_method column to company_settings
-- Supports kontantmetoden (cash) vs faktureringsmetoden (accrual)
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS accounting_method text NOT NULL DEFAULT 'accrual'
  CHECK (accounting_method IN ('accrual', 'cash'));
