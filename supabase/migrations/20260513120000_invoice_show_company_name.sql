-- Add invoice_show_company_name toggle for invoice PDF header.
-- When false, the company name is hidden under the logo in the invoice PDF.
-- Default true preserves existing invoice layout for all current users.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_show_company_name boolean DEFAULT true;

NOTIFY pgrst, 'reload schema';
