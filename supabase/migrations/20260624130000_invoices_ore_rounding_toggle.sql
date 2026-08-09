-- Per-invoice öresavrundning toggle for customer and supplier invoices.
--
-- This is a DISPLAY-ONLY override. getDisplayTotal() (lib/invoices/rounding.ts)
-- reads this flag when rendering totals (invoice PDF, list, detail). The stored
-- subtotal/vat_amount/total/remaining_amount and the journal entries are NOT
-- affected — the exact öre amount remains the source of truth behind the scenes.
--
-- NULL semantics differ by table, enforced in the display helper, not here:
--   invoices         — NULL inherits company_settings.ore_rounding (rounding has
--                      always been company-default-on for customer invoices).
--   supplier_invoices — NULL means "off" (supplier invoices never had rounding;
--                      we must not retroactively round historical rows).
--
-- Nullable, no default: existing rows stay NULL and keep their prior rendering.
-- New rows get an explicit boolean written by the create routes (defaulted from
-- the company-wide setting in the editor). No RLS/trigger impact — row-level
-- policies already cover every column.

alter table public.invoices
  add column if not exists ore_rounding boolean;

comment on column public.invoices.ore_rounding is
  'Per-invoice öresavrundning override (display-only). NULL inherits company_settings.ore_rounding. Does not affect stored amounts or journal entries.';

alter table public.supplier_invoices
  add column if not exists ore_rounding boolean;

comment on column public.supplier_invoices.ore_rounding is
  'Per-invoice öresavrundning override (display-only). NULL = off. Does not affect stored amounts or journal entries.';
