-- VAT filing periods use beskattningsunderlag, while employer-declaration
-- deadlines use company turnover. Preserve the former combined answer as the
-- initial value for both settings so existing companies keep their dates.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS vat_taxable_base_over_40m boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employer_turnover_over_40m boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'company_settings'
      AND column_name = 'tax_turnover_over_40m'
  ) THEN
    EXECUTE '
      UPDATE public.company_settings
      SET
        vat_taxable_base_over_40m = tax_turnover_over_40m,
        employer_turnover_over_40m = tax_turnover_over_40m
    ';
  END IF;
END
$$;

-- Keep tax_turnover_over_40m temporarily for rollback compatibility with an
-- older application instance during deployment. New code no longer reads or
-- writes it; remove it in a later migration after the split fields are live.

NOTIFY pgrst, 'reload schema';
