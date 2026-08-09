-- Make invoices.invoice_number nullable.
-- Drafts no longer reserve a number at creation; numbers are assigned at the
-- moment status transitions to 'sent'. The partial unique index
-- idx_invoices_company_invoice_number (WHERE invoice_number IS NOT NULL) from
-- 20260330130000_multi_tenant_company_refactor.sql already permits multiple
-- NULLs, so no index changes are required.

ALTER TABLE public.invoices
  ALTER COLUMN invoice_number DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
