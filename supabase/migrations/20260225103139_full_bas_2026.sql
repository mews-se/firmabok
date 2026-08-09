-- Migration 42: Full BAS 2026 support
-- Adds k2_excluded column and backfills K2-excluded account numbers.

-- =============================================================================
-- 1. Add k2_excluded column
-- =============================================================================

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS k2_excluded boolean DEFAULT false;

-- =============================================================================
-- 2. Backfill k2_excluded = true for BAS 2026 K2-excluded accounts
-- These accounts are marked with # in BAS Kontoplan 2026 v1.0 and should
-- not be used when K2 accounting framework is applied.
-- =============================================================================

UPDATE public.chart_of_accounts
SET k2_excluded = true, updated_at = now()
WHERE account_number IN (
  '1010', '1011', '1012', '1018', '1019',
  '1370',
  '1518',
  '2092', '2096',
  '2240',
  '2448',
  '3940',
  '7940',
  '8290', '8291', '8295',
  '8320', '8321', '8325',
  '8450', '8451', '8455',
  '8480',
  '8940'
)
AND k2_excluded = false;

-- =============================================================================
-- 3. Re-run SRU code backfill for any accounts with sru_code IS NULL
-- Uses the same range logic as migration 021.
-- =============================================================================

-- NE: R1 - Försäljning med moms (3000-3499 excl 3100)
UPDATE public.chart_of_accounts
SET sru_code = '7310', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '3000' AND account_number <= '3499'
  AND account_number != '3100';

-- NE: R2 - Momsfria intäkter (3100, 3900, 3970-3980)
UPDATE public.chart_of_accounts
SET sru_code = '7311', updated_at = now()
WHERE sru_code IS NULL
  AND (
    account_number = '3100'
    OR account_number = '3900'
    OR (account_number >= '3970' AND account_number <= '3980')
  );

-- NE: R4 - Ränteintäkter (8310-8330)
UPDATE public.chart_of_accounts
SET sru_code = '7313', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8310' AND account_number <= '8330';

-- NE: R5 - Varuinköp (4000-4990)
UPDATE public.chart_of_accounts
SET sru_code = '7320', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '4000' AND account_number <= '4990';

-- NE: R6 - Övriga kostnader (5000-6990, 7970)
UPDATE public.chart_of_accounts
SET sru_code = '7321', updated_at = now()
WHERE sru_code IS NULL
  AND (
    (account_number >= '5000' AND account_number <= '6990')
    OR account_number = '7970'
  );

-- NE: R7 - Lönekostnader (7000-7699)
UPDATE public.chart_of_accounts
SET sru_code = '7322', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7000' AND account_number <= '7699';

-- NE: R8 - Räntekostnader (8400-8499)
UPDATE public.chart_of_accounts
SET sru_code = '7323', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8400' AND account_number <= '8499';

-- NE: R9 - Avskrivningar fastighet (7820)
UPDATE public.chart_of_accounts
SET sru_code = '7324', updated_at = now()
WHERE sru_code IS NULL
  AND account_number = '7820';

-- NE: R10 - Avskrivningar övrigt (7700-7899 excl 7820)
UPDATE public.chart_of_accounts
SET sru_code = '7325', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7700' AND account_number <= '7899'
  AND account_number != '7820';

-- INK2: Balance sheet fallbacks
UPDATE public.chart_of_accounts SET sru_code = '7201', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1000' AND account_number <= '1099';

UPDATE public.chart_of_accounts SET sru_code = '7202', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1100' AND account_number <= '1299';

UPDATE public.chart_of_accounts SET sru_code = '7203', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1300' AND account_number <= '1399';

UPDATE public.chart_of_accounts SET sru_code = '7210', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1400' AND account_number <= '1499';

UPDATE public.chart_of_accounts SET sru_code = '7211', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1500' AND account_number <= '1599';

UPDATE public.chart_of_accounts SET sru_code = '7212', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '1600' AND account_number <= '1999';

UPDATE public.chart_of_accounts SET sru_code = '7220', updated_at = now()
WHERE sru_code IS NULL AND account_number = '2081';

UPDATE public.chart_of_accounts SET sru_code = '7221', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '2085' AND account_number <= '2098';

UPDATE public.chart_of_accounts SET sru_code = '7222', updated_at = now()
WHERE sru_code IS NULL AND account_number = '2099';

UPDATE public.chart_of_accounts SET sru_code = '7230', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '2100' AND account_number <= '2499';

UPDATE public.chart_of_accounts SET sru_code = '7231', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '2500' AND account_number <= '2999';

-- INK2: Remaining income statement fallbacks
UPDATE public.chart_of_accounts SET sru_code = '7310', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '3000' AND account_number <= '3999';

UPDATE public.chart_of_accounts SET sru_code = '7320', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '4000' AND account_number <= '4999';

UPDATE public.chart_of_accounts SET sru_code = '7330', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '5000' AND account_number <= '6999';

UPDATE public.chart_of_accounts SET sru_code = '7340', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '7000' AND account_number <= '7699';

UPDATE public.chart_of_accounts SET sru_code = '7350', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '7700' AND account_number <= '7899';

UPDATE public.chart_of_accounts SET sru_code = '7360', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '7900' AND account_number <= '7999';

UPDATE public.chart_of_accounts SET sru_code = '7370', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '8000' AND account_number <= '8499';

UPDATE public.chart_of_accounts SET sru_code = '7380', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '8500' AND account_number <= '8999';

-- Equity accounts not covered above (2000-2084)
UPDATE public.chart_of_accounts SET sru_code = '7221', updated_at = now()
WHERE sru_code IS NULL AND account_number >= '2000' AND account_number <= '2084';
