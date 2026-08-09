-- Add invoice_company_name_position to control whether the company name
-- appears in the invoice PDF header (under the logo) or in the footer.
-- Default 'header' preserves existing layout for all current users.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_company_name_position text
    NOT NULL DEFAULT 'header'
    CHECK (invoice_company_name_position IN ('header', 'footer'));

NOTIFY pgrst, 'reload schema';
