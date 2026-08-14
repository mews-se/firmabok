-- Invoice payment links are an explicit opt-in on the invoice settings page.
-- When invoice_payment_links_enabled is false the editor hides the whole
-- payment-link section. Default false for everyone.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_payment_links_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.invoice_payment_links_enabled IS
  'Opt-in for the invoice payment-link feature: shows the payment-link field in the invoice editor. Default off; toggled on the invoice settings page.';

NOTIFY pgrst, 'reload schema';
