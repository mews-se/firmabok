-- Add multi-line booking pattern support to categorization templates.
-- Null = legacy single debit/credit pair. Array of {account, type, side, ratio?, vat_rate?}.
-- VAT lines store vat_rate (computed exactly), business/tax lines store ratio (of non-VAT amount).

ALTER TABLE public.categorization_templates
  ADD COLUMN line_pattern JSONB;

COMMENT ON COLUMN public.categorization_templates.line_pattern IS
  'Multi-line booking pattern. Null = use debit_account/credit_account. Array of {account, type, side, ratio?, vat_rate?}. Ratios are relative to the non-VAT subtotal.';
