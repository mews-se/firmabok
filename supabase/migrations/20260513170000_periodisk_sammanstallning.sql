-- Add fields to company_settings needed for periodisk sammanställning (SKV 5740).
--
-- periodisk_sammanstallning_period:
--   Separate from moms_period because:
--   1. PS does not support 'yearly' (only monthly or quarterly).
--   2. Goods sellers must report monthly even if VAT is quarterly
--      (35 kap. 2 § SFL).
--   3. Services-only sellers can apply for quarterly independently.
--
-- tax_contact_*:
--   The SKV574008 file header requires contact person + phone + email of the
--   declarant. Stored on company_settings so it is reusable for future
--   Skatteverket filings (e.g. AGI, momsdeklaration export).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS periodisk_sammanstallning_period text,
  ADD COLUMN IF NOT EXISTS tax_contact_name text,
  ADD COLUMN IF NOT EXISTS tax_contact_phone text,
  ADD COLUMN IF NOT EXISTS tax_contact_email text;

-- Backfill: monthly default for everyone except quarterly VAT-payers.
UPDATE public.company_settings
  SET periodisk_sammanstallning_period = CASE
    WHEN moms_period = 'quarterly' THEN 'quarterly'
    ELSE 'monthly'
  END
  WHERE periodisk_sammanstallning_period IS NULL;

ALTER TABLE public.company_settings
  ALTER COLUMN periodisk_sammanstallning_period SET DEFAULT 'monthly';

ALTER TABLE public.company_settings
  ALTER COLUMN periodisk_sammanstallning_period SET NOT NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_ps_period_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_ps_period_check
  CHECK (periodisk_sammanstallning_period IN ('monthly', 'quarterly'));

NOTIFY pgrst, 'reload schema';
