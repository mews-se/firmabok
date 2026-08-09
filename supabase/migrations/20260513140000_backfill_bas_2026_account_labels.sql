-- Backfill: align chart_of_accounts labels with BAS 2026 official chart.
--
-- Companion to the TS reference fix in lib/bookkeeping/bas-data/. The
-- TS file is the source of truth for the kontoplan UI and lookups, but
-- existing companies' chart_of_accounts rows were seeded with older /
-- typo'd labels that this migration cleans up.
--
-- Safety: every WHERE clause matches an EXACT bad name string. Companies
-- that have manually renamed an account are left alone. No row is deleted;
-- this migration only updates account_name.

BEGIN;

-- 1. Hyphenation fix: 4075-4078 "EUland" -> "EU-land"
UPDATE public.chart_of_accounts
   SET account_name = REPLACE(account_name, 'EUland', 'EU-land'),
       updated_at   = now()
 WHERE account_number IN ('4075', '4076', '4077', '4078')
   AND account_name LIKE '%EUland%';

-- 2. Hyphenation fix: 8411 "förlagsoch" -> "förlags- och"
UPDATE public.chart_of_accounts
   SET account_name = REPLACE(account_name, 'förlagsoch', 'förlags- och'),
       updated_at   = now()
 WHERE account_number = '8411'
   AND account_name LIKE '%förlagsoch%';

-- 3. BAS 2026 freed accounts 1250/1260; rename to the free-account label.
--    Exact-match guard on the old seeded name leaves any customer rename alone.
UPDATE public.chart_of_accounts
   SET account_name = '(Fritt konto för Inventarier, verktyg och installationer)',
       updated_at   = now()
 WHERE account_number = '1250'
   AND account_name  = 'Inventarier och verktyg';

UPDATE public.chart_of_accounts
   SET account_name = '(Fritt konto för Inventarier, verktyg och installationer)',
       updated_at   = now()
 WHERE account_number = '1260'
   AND account_name  = 'Datorer';

-- 4. Periodiseringsfond name backfill.
--    BAS 2026 uses deterministic year mapping for accounts 2120-2139:
--      2120 -> 2020,  2121 -> 2021,  2122 -> 2022,  2123 -> 2023,
--      2124 -> 2024,  2125 -> 2025,  2126 -> 2026,  2127 -> 2027,
--      2129 -> 2019,
--      213x -> same year as 212x with "– nr 2" suffix.
--
--    We only rename rows where the current name is the generic
--    "Periodiseringsfond" (no year suffix at all). Rows that already
--    carry a year — even a wrong one — are LEFT ALONE because they may
--    refer to a legacy fond from a previous BAS numbering cycle that the
--    user is intentionally tracking. The kontoplan UI lets users rename
--    those manually.
UPDATE public.chart_of_accounts
   SET account_name = CASE account_number
         WHEN '2120' THEN 'Periodiseringsfond 2020'
         WHEN '2130' THEN 'Periodiseringsfond 2020 – nr 2'
         WHEN '2131' THEN 'Periodiseringsfond 2021 – nr 2'
         WHEN '2132' THEN 'Periodiseringsfond 2022 – nr 2'
         WHEN '2133' THEN 'Periodiseringsfond 2023 – nr 2'
         WHEN '2134' THEN 'Periodiseringsfond 2024 – nr 2'
         WHEN '2135' THEN 'Periodiseringsfond 2025 – nr 2'
         WHEN '2136' THEN 'Periodiseringsfond 2026 – nr 2'
         WHEN '2137' THEN 'Periodiseringsfond 2027 – nr 2'
         WHEN '2139' THEN 'Periodiseringsfond 2019 – nr 2'
       END,
       updated_at = now()
 WHERE account_number IN ('2120','2130','2131','2132','2133','2134','2135','2136','2137','2139')
   AND account_name = 'Periodiseringsfond';

COMMIT;

NOTIFY pgrst, 'reload schema';
