-- Issue #967 "Registrera men bokför inte": let companies split registering
-- invoices from booking them. Many companies have one person who creates the
-- customer invoice / registers the supplier invoice while ekonomi books it
-- with the correct kontering afterwards.
--
-- When defer_invoice_booking is true AND the company uses faktureringsmetoden
-- (accrual), registering a supplier invoice or sending a customer invoice no
-- longer creates the journal entry inline; a separate explicit "Bokför"
-- action (POST /api/supplier-invoices/[id]/book, /api/invoices/[id]/book)
-- posts it later. Kontantmetoden companies already defer booking to payment,
-- so the flag is a no-op for them. Default false keeps every existing
-- company on the book-immediately behavior.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS defer_invoice_booking boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.defer_invoice_booking IS
  'When true (faktureringsmetoden only): registering supplier invoices / sending customer invoices does not book them; booking is a separate explicit step (#967).';

NOTIFY pgrst, 'reload schema';
