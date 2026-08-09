-- Migration 52: Fix incorrect VAT account names for existing users
--
-- Migration 009 seeded accounts 2610/2611/2612 with wrong names:
--   2610 → "Utgaende moms 25%" (should not exist; 2611 is the correct account)
--   2611 → "Utgaende moms 12%" (WRONG — 2611 is 25%, 2621 is 12%)
--   2612 → "Utgaende moms 6%"  (WRONG — 2612 doesn't exist in BAS, 2631 is 6%)
--
-- Migration 021 fixed the seed function for new users but didn't fix existing data.
-- This migration corrects the account_name for any existing rows.

-- Fix 2611: was incorrectly labeled as 12%, should be 25%
UPDATE public.chart_of_accounts
SET account_name = 'Utgaende moms forsaljning 25%', updated_at = now()
WHERE account_number = '2611'
  AND account_name IN ('Utgaende moms 12%', 'Utgående moms 12%');
