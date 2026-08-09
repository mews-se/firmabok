-- The 26th filing day for the skattedeklaration (AGI and VAT together) is
-- triggered by one statutory measure: a VAT taxable base above SEK 40 million
-- (SFL 26 kap.). No separate employer-turnover measure exists, so the split
-- introduced by 20260716120353 could show a non-VAT-reporting employer the
-- 26th when its binding AGI deadline is the 12th. Drop the employer column.

ALTER TABLE public.company_settings
  DROP COLUMN IF EXISTS employer_turnover_over_40m;

-- Clear the VAT flag where the stored combination is not legally coherent
-- (the flag requires VAT registration and monthly reporting). Ambiguous
-- companies fall back to the small-company schedule, whose dates are always
-- earlier and therefore never produce a late filing.
UPDATE public.company_settings
SET vat_taxable_base_over_40m = false
WHERE vat_taxable_base_over_40m
  AND (vat_registered IS DISTINCT FROM true OR moms_period IS DISTINCT FROM 'monthly');

NOTIFY pgrst, 'reload schema';
