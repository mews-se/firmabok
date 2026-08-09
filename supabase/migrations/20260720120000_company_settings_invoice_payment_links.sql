-- Invoice payment links become an explicit opt-in on the invoice settings
-- page. Previously the payment-link field was always visible in the invoice
-- editor and a Stripe payment link was auto-created on every send for any
-- company with an active Stripe connection (payment_link_auto defaults on).
--
-- When invoice_payment_links_enabled is false the editor hides the whole
-- payment-link section and the send routes skip link creation entirely
-- (gated server-side in maybeCreatePaymentLinkForInvoice, so v1/MCP and
-- recurring sends obey it too). Default false for everyone, deliberately
-- including companies already connected to Stripe: they opt back in from
-- the invoice settings page.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_payment_links_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.invoice_payment_links_enabled IS
  'Opt-in for the invoice payment-link feature: shows the payment-link field in the invoice editor and enables automatic Stripe payment links on send. Default off; toggled on the invoice settings page.';

NOTIFY pgrst, 'reload schema';
