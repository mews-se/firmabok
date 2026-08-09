-- The `customers` table was missing the boolean `vat_number_validated` flag that
-- `types/index.ts` and ~40 code sites depend on: getVatRules/getAvailableVatRates,
-- the customers-list "validated" badge, and the v1 customers API column select.
-- It went unnoticed because normal customer creation only writes the flag when a
-- VIES check runs, and reads degrade to undefined when the column is absent. The
-- arcim-migration importer writes it unconditionally (vat_number_validated: false),
-- so customer + sales-invoice-stub inserts failed with PostgREST "Could not find
-- the 'vat_number_validated' column of 'customers' in the schema cache".
-- This flag is distinct from the existing `vat_number_validated_at` timestamp,
-- which records when the last successful VIES check happened.
alter table public.customers
  add column if not exists vat_number_validated boolean not null default false;
