-- Drop the legacy user_id-scoped unique constraints on supplier_invoices that
-- the multi-tenant refactor (20260330130000) missed.
--
-- That refactor tried to drop constraints named
--   supplier_invoices_user_id_arrival_number_key
--   supplier_invoices_user_id_supplier_id_supplier_invoice_numbe_key
-- (the auto-generated names Postgres would have picked had the original
-- CREATE TABLE used inline UNIQUE constraints). But the 20240101000025
-- migration named them explicitly — uq_supplier_invoices_arrival and
-- uq_supplier_invoices_ref — so the IF EXISTS drops were no-ops and the
-- user_id-scoped uniqueness remained in place.
--
-- Meanwhile get_next_arrival_number() was rewritten to scope by company_id.
-- The mismatch blows up the moment a single user has supplier invoices in
-- two companies: the second company's arrival_number restarts at 1 and
-- collides with the first company's row under the user_id-scoped constraint.
--
-- The correct composite unique indexes — (company_id, arrival_number) and
-- (company_id, supplier_id, supplier_invoice_number) — were added as
-- CREATE UNIQUE INDEX IF NOT EXISTS in the 2026-03-30 refactor and are
-- already in place, so dropping the legacy constraints is all that's
-- needed.

ALTER TABLE public.supplier_invoices
  DROP CONSTRAINT IF EXISTS uq_supplier_invoices_arrival,
  DROP CONSTRAINT IF EXISTS uq_supplier_invoices_ref;

NOTIFY pgrst, 'reload schema';
