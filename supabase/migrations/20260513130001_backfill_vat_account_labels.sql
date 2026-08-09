-- Backfill: fix VAT account labels on companies that were seeded by the
-- regressed seed_chart_of_accounts() between 2026-03-30 and 2026-05-13.
--
-- Companion to 20260513120000_fix_vat_seed_chart_of_accounts.sql. The earlier
-- migration patched the seed function so new companies get correct labels.
-- This one cleans up companies that were already created with the bad seed.
--
-- Safety notes:
--   * Every WHERE clause matches the EXACT bad-seed name, so customers who
--     have already manually renamed an account are left alone.
--   * Orphan 2610 / 2612 rows are only deleted if no journal line references
--     them. The engine never routes to 2610/2612, so this should be true for
--     all bad-seed companies; the guard is defense in depth.
--   * 2621 / 2631 are inserted only for companies that show the bad-seed
--     fingerprint (a mislabelled 2611 carrying one of the two bad-seed names).
--     plan_type is derived from that sibling 2611 row rather than hardcoded
--     to 'k1', so any company that manually adjusted plan_type keeps it.

BEGIN;

-- 1. Rename mislabelled 2611 -> 25%
UPDATE public.chart_of_accounts
   SET account_name = 'Utgaende moms forsaljning inom Sverige, 25%',
       updated_at   = now()
 WHERE account_number = '2611'
   AND account_name IN ('Utgaende moms 12%', 'Utgående moms 12%');

-- 2. Insert missing 2621 (12%) for bad-seed companies that lack it.
--    Scoped to companies that had the bad-seed fingerprint on 2611
--    (rename in step 1 above, or the orphan 2610/2612 pattern in step 4).
INSERT INTO public.chart_of_accounts
  (user_id, company_id, account_number, account_name, account_class,
   account_group, account_type, normal_balance, plan_type, is_system_account)
SELECT c.created_by,
       c.id,
       '2621',
       'Utgaende moms forsaljning inom Sverige, 12%',
       2, '26', 'liability', 'credit', sibling.plan_type, true
  FROM public.companies c
  JOIN public.chart_of_accounts sibling
    ON sibling.company_id = c.id
   AND sibling.account_number = '2611'
 WHERE sibling.account_name = 'Utgaende moms forsaljning inom Sverige, 25%'
   AND NOT EXISTS (
         SELECT 1 FROM public.chart_of_accounts coa
          WHERE coa.company_id = c.id
            AND coa.account_number = '2621'
       );

-- 3. Insert missing 2631 (6%) for bad-seed companies that lack it.
INSERT INTO public.chart_of_accounts
  (user_id, company_id, account_number, account_name, account_class,
   account_group, account_type, normal_balance, plan_type, is_system_account)
SELECT c.created_by,
       c.id,
       '2631',
       'Utgaende moms forsaljning inom Sverige,  6%',
       2, '26', 'liability', 'credit', sibling.plan_type, true
  FROM public.companies c
  JOIN public.chart_of_accounts sibling
    ON sibling.company_id = c.id
   AND sibling.account_number = '2611'
 WHERE sibling.account_name = 'Utgaende moms forsaljning inom Sverige, 25%'
   AND NOT EXISTS (
         SELECT 1 FROM public.chart_of_accounts coa
          WHERE coa.company_id = c.id
            AND coa.account_number = '2631'
       );

-- 4. Remove orphan 2610 / 2612 rows created by the bad seed.
--    Only rows that (a) still carry the bad-seed name verbatim, and
--    (b) have zero postings on journal_entry_lines are removed.
DELETE FROM public.chart_of_accounts coa
 WHERE coa.account_number IN ('2610', '2612')
   AND coa.account_name IN (
         'Utgaende moms 25%', 'Utgående moms 25%',
         'Utgaende moms 6%',  'Utgående moms 6%'
       )
   AND coa.is_system_account = true
   AND NOT EXISTS (
         SELECT 1
           FROM public.journal_entry_lines jel
           JOIN public.journal_entries je ON je.id = jel.journal_entry_id
          WHERE jel.account_number = coa.account_number
            AND je.company_id      = coa.company_id
       );

COMMIT;

NOTIFY pgrst, 'reload schema';
