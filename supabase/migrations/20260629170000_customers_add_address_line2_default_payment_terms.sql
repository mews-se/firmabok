-- The `customers` table was missing `address_line2` and `default_payment_terms`
-- even though the sibling `suppliers` table has both, and several code paths
-- insert/select them on customers:
--   * extensions/general/arcim-migration (provider migration importer)
--   * app/api/import/customers/execute  (built-in customer CSV import)
--   * app/api/export/customers          (customer CSV export)
-- Inserts therefore failed with PostgREST "Could not find the 'address_line2'
-- column of 'customers' in the schema cache", so customer migration/import
-- silently imported 0 rows. Add the two columns to match `suppliers`.
alter table public.customers
  add column if not exists address_line2 text,
  add column if not exists default_payment_terms integer default 30;
