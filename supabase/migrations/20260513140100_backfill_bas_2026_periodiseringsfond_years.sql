-- Follow-up backfill: fix wrong-year labels on Periodiseringsfond accounts.
--
-- The previous migration (20260513140000) only renamed accounts whose name
-- was the generic "Periodiseringsfond" (no year). It deliberately left rows
-- with any year suffix alone, since a year tag could indicate intentional
-- legacy data. In practice it turned out that many customers were seeded
-- from an older BAS numbering cycle where 2126 = "2016", 2127 = "2017", etc.
-- BAS 2026 reuses those same account numbers for years 2026/2027.
--
-- This migration aligns the year tag with the BAS 2026 meaning of each
-- account number. To avoid clobbering customer-customised names, we only
-- touch rows whose name matches a known seeded shape:
--   "Periodiseringsfond"
--   "Periodiseringsfond YYYY"
--   "Periodiseringsfond YYYY – nr 2"
-- Anything else (e.g. "Min fond 2016", "Periodiseringsfond – avslutad") is
-- left alone.

BEGIN;

UPDATE public.chart_of_accounts
   SET account_name = CASE account_number
         WHEN '2120' THEN 'Periodiseringsfond 2020'
         WHEN '2121' THEN 'Periodiseringsfond 2021'
         WHEN '2122' THEN 'Periodiseringsfond 2022'
         WHEN '2123' THEN 'Periodiseringsfond 2023'
         WHEN '2124' THEN 'Periodiseringsfond 2024'
         WHEN '2125' THEN 'Periodiseringsfond 2025'
         WHEN '2126' THEN 'Periodiseringsfond 2026'
         WHEN '2127' THEN 'Periodiseringsfond 2027'
         WHEN '2129' THEN 'Periodiseringsfond 2019'
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
 WHERE account_number IN (
         '2120','2121','2122','2123','2124','2125','2126','2127','2129',
         '2130','2131','2132','2133','2134','2135','2136','2137','2139'
       )
   AND account_name ~ '^Periodiseringsfond( \d{4}( – nr 2)?)?$'
   AND account_name <> CASE account_number
         WHEN '2120' THEN 'Periodiseringsfond 2020'
         WHEN '2121' THEN 'Periodiseringsfond 2021'
         WHEN '2122' THEN 'Periodiseringsfond 2022'
         WHEN '2123' THEN 'Periodiseringsfond 2023'
         WHEN '2124' THEN 'Periodiseringsfond 2024'
         WHEN '2125' THEN 'Periodiseringsfond 2025'
         WHEN '2126' THEN 'Periodiseringsfond 2026'
         WHEN '2127' THEN 'Periodiseringsfond 2027'
         WHEN '2129' THEN 'Periodiseringsfond 2019'
         WHEN '2130' THEN 'Periodiseringsfond 2020 – nr 2'
         WHEN '2131' THEN 'Periodiseringsfond 2021 – nr 2'
         WHEN '2132' THEN 'Periodiseringsfond 2022 – nr 2'
         WHEN '2133' THEN 'Periodiseringsfond 2023 – nr 2'
         WHEN '2134' THEN 'Periodiseringsfond 2024 – nr 2'
         WHEN '2135' THEN 'Periodiseringsfond 2025 – nr 2'
         WHEN '2136' THEN 'Periodiseringsfond 2026 – nr 2'
         WHEN '2137' THEN 'Periodiseringsfond 2027 – nr 2'
         WHEN '2139' THEN 'Periodiseringsfond 2019 – nr 2'
       END;

COMMIT;

NOTIFY pgrst, 'reload schema';
