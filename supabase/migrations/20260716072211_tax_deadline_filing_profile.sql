-- Add the filing-profile inputs required to calculate statutory tax deadlines.
-- Defaults represent the common small-company digital filing path. EU sales
-- list deadlines stay disabled until the company explicitly opts in because
-- VAT registration alone does not create that filing obligation.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS tax_turnover_over_40m boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_has_eu_trade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_filing_method text NOT NULL DEFAULT 'electronic',
  ADD COLUMN IF NOT EXISTS periodisk_sammanstallning_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS periodisk_sammanstallning_filing_method text NOT NULL DEFAULT 'electronic';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_vat_filing_method_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_vat_filing_method_check
  CHECK (vat_filing_method IN ('electronic', 'paper'));

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_ps_filing_method_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_ps_filing_method_check
  CHECK (periodisk_sammanstallning_filing_method IN ('electronic', 'paper'));

NOTIFY pgrst, 'reload schema';
