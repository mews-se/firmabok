-- Expand chart_of_accounts account_type CHECK constraint to include 'untaxed_reserves'
-- BAS accounts 21xx (obeskattade reserver) use this type in the BAS reference data.
-- Without this, SIE imports that include accounts like 2110-2199 fail with a
-- CHECK constraint violation when auto-activating BAS accounts.

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_account_type_check;

ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_account_type_check
  CHECK (account_type IN ('asset', 'equity', 'liability', 'revenue', 'expense', 'untaxed_reserves'));
