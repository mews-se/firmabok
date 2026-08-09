-- Add pays_salaries column to company_settings
-- Required by tax deadline logic (arbetsgivardeklaration for aktiebolag)
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS pays_salaries boolean NOT NULL DEFAULT false;
