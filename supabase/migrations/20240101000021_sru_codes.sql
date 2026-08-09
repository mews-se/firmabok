-- Migration 21: Backfill SRU codes on chart_of_accounts
-- Updates existing accounts with standard SRU codes for NE (EF) and INK2 (AB) forms.
-- Only updates accounts where sru_code IS NULL to preserve manual assignments.

-- Add sru_code column if it doesn't exist
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS sru_code text;

-- =============================================================================
-- Backfill SRU codes for NE form (Enskild firma) — field codes 7310-7350
-- These apply to revenue/expense accounts (classes 3-8)
-- =============================================================================

-- NE: R1 - Försäljning med moms (3000-3499 excl 3100) → 7310
UPDATE public.chart_of_accounts
SET sru_code = '7310', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '3000' AND account_number <= '3499'
  AND account_number != '3100';

-- NE: R2 - Momsfria intäkter (3100, 3900, 3970-3980) → 7311
UPDATE public.chart_of_accounts
SET sru_code = '7311', updated_at = now()
WHERE sru_code IS NULL
  AND (
    account_number = '3100'
    OR account_number = '3900'
    OR (account_number >= '3970' AND account_number <= '3980')
  );

-- NE: R3 - Bil/bostadsförmån (3200-3299) → 7312
UPDATE public.chart_of_accounts
SET sru_code = '7312', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '3200' AND account_number <= '3299';

-- NE: R4 - Ränteintäkter (8310-8330) → 7313
UPDATE public.chart_of_accounts
SET sru_code = '7313', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8310' AND account_number <= '8330';

-- NE: R5 - Varuinköp (4000-4990) → 7320
UPDATE public.chart_of_accounts
SET sru_code = '7320', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '4000' AND account_number <= '4990';

-- NE: R6 - Övriga kostnader (5000-6990, 7970) → 7321
UPDATE public.chart_of_accounts
SET sru_code = '7321', updated_at = now()
WHERE sru_code IS NULL
  AND (
    (account_number >= '5000' AND account_number <= '6990')
    OR account_number = '7970'
  );

-- NE: R7 - Lönekostnader (7000-7699) → 7322
UPDATE public.chart_of_accounts
SET sru_code = '7322', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7000' AND account_number <= '7699';

-- NE: R8 - Räntekostnader (8400-8499) → 7323
UPDATE public.chart_of_accounts
SET sru_code = '7323', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8400' AND account_number <= '8499';

-- NE: R9 - Avskrivningar fastighet (7820) → 7324
UPDATE public.chart_of_accounts
SET sru_code = '7324', updated_at = now()
WHERE sru_code IS NULL
  AND account_number = '7820';

-- NE: R10 - Avskrivningar övrigt (7700-7899 excl 7820) → 7325
UPDATE public.chart_of_accounts
SET sru_code = '7325', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7700' AND account_number <= '7899'
  AND account_number != '7820';

-- =============================================================================
-- Backfill SRU codes for INK2 form (Aktiebolag) — field codes 7200-7499
-- These apply to balance sheet accounts (classes 1-2) that don't have
-- NE codes above. Revenue/expense accounts already got NE codes which
-- overlap with INK2 for classes 3-8.
-- =============================================================================

-- INK2: Immateriella anläggningstillgångar (1000-1099) → 7201
UPDATE public.chart_of_accounts
SET sru_code = '7201', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1000' AND account_number <= '1099';

-- INK2: Materiella anläggningstillgångar (1100-1299) → 7202
UPDATE public.chart_of_accounts
SET sru_code = '7202', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1100' AND account_number <= '1299';

-- INK2: Finansiella anläggningstillgångar (1300-1399) → 7203
UPDATE public.chart_of_accounts
SET sru_code = '7203', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1300' AND account_number <= '1399';

-- INK2: Varulager (1400-1499) → 7210
UPDATE public.chart_of_accounts
SET sru_code = '7210', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1400' AND account_number <= '1499';

-- INK2: Kundfordringar (1500-1599) → 7211
UPDATE public.chart_of_accounts
SET sru_code = '7211', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1500' AND account_number <= '1599';

-- INK2: Övriga omsättningstillgångar (1600-1999) → 7212
UPDATE public.chart_of_accounts
SET sru_code = '7212', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '1600' AND account_number <= '1999';

-- INK2: Aktiekapital (2081) → 7220
UPDATE public.chart_of_accounts
SET sru_code = '7220', updated_at = now()
WHERE sru_code IS NULL
  AND account_number = '2081';

-- INK2: Övrigt eget kapital (2085-2098) → 7221
UPDATE public.chart_of_accounts
SET sru_code = '7221', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '2085' AND account_number <= '2098';

-- INK2: Årets resultat (2099) → 7222
UPDATE public.chart_of_accounts
SET sru_code = '7222', updated_at = now()
WHERE sru_code IS NULL
  AND account_number = '2099';

-- INK2: Skulder (2100-2499) → 7230
UPDATE public.chart_of_accounts
SET sru_code = '7230', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '2100' AND account_number <= '2499';

-- INK2: Övriga skulder (2500-2999) → 7231
UPDATE public.chart_of_accounts
SET sru_code = '7231', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '2500' AND account_number <= '2999';

-- =============================================================================
-- Also assign remaining class 3-8 accounts that weren't covered by NE codes
-- (for INK2 users). These use broader INK2 ranges.
-- =============================================================================

-- INK2: Nettoomsättning (3000-3999 not already assigned) → 7310
UPDATE public.chart_of_accounts
SET sru_code = '7310', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '3000' AND account_number <= '3999';

-- INK2: Varuinköp (4000-4999 not already assigned) → 7320
UPDATE public.chart_of_accounts
SET sru_code = '7320', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '4000' AND account_number <= '4999';

-- INK2: Övriga externa kostnader (5000-6999 not already assigned) → 7330
UPDATE public.chart_of_accounts
SET sru_code = '7330', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '5000' AND account_number <= '6999';

-- INK2: Personalkostnader (7000-7699 not already assigned) → 7340
UPDATE public.chart_of_accounts
SET sru_code = '7340', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7000' AND account_number <= '7699';

-- INK2: Avskrivningar (7700-7899 not already assigned) → 7350
UPDATE public.chart_of_accounts
SET sru_code = '7350', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7700' AND account_number <= '7899';

-- INK2: Övriga rörelsekostnader (7900-7999 not already assigned) → 7360
UPDATE public.chart_of_accounts
SET sru_code = '7360', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '7900' AND account_number <= '7999';

-- INK2: Finansiella poster (8000-8499 not already assigned) → 7370
UPDATE public.chart_of_accounts
SET sru_code = '7370', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8000' AND account_number <= '8499';

-- INK2: Extraordinära poster (8500-8999) → 7380
UPDATE public.chart_of_accounts
SET sru_code = '7380', updated_at = now()
WHERE sru_code IS NULL
  AND account_number >= '8500' AND account_number <= '8999';

-- =============================================================================
-- Update seed_chart_of_accounts to include sru_code for new users
-- =============================================================================
create or replace function public.seed_chart_of_accounts(p_user_id uuid, p_entity_type text)
returns void
language plpgsql
security definer
as $$
declare
  v_account_count integer;
begin
  -- Only seed if user has no existing accounts
  select count(*) into v_account_count
  from public.chart_of_accounts
  where user_id = p_user_id;

  if v_account_count > 0 then
    return;
  end if;

  -- =========================================================================
  -- Assets (1xxx) - Common to both EF and AB
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true, '7211'),
    (p_user_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true, '7212'),
    (p_user_id, '1930', 'Foretagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true, '7212'),
    (p_user_id, '1940', 'Ovriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true, '7212');

  -- =========================================================================
  -- Equity (2xxx) - Entity-type dependent
  -- =========================================================================
  if p_entity_type = 'enskild_firma' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    values
      (p_user_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true, '7221'),
      (p_user_id, '2013', 'Ovriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true, '7221'),
      (p_user_id, '2018', 'Ovriga egna insattningar', 2, '20', 'equity', 'credit', 'k1', true, '7221');
  end if;

  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    values
      (p_user_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true, '7220'),
      (p_user_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true, '7221'),
      (p_user_id, '2099', 'Arets resultat', 2, '20', 'equity', 'credit', 'k1', true, '7222');
  end if;

  -- =========================================================================
  -- Liabilities (2xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '2440', 'Leverantorsskulder', 2, '24', 'liability', 'credit', 'k1', true, '7230'),
    (p_user_id, '2611', 'Utgaende moms forsaljning 25%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2621', 'Utgaende moms forsaljning 12%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2631', 'Utgaende moms forsaljning 6%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2614', 'Utg moms omvand skattskyldighet 25%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2624', 'Utg moms omvand skattskyldighet 12%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2634', 'Utg moms omvand skattskyldighet 6%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2641', 'Debiterad ingaende moms', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2645', 'Beraknad ingaende moms forvarv utlandet', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2650', 'Redovisningskonto for moms', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true, '7231'),
    (p_user_id, '2731', 'Avrakning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true, '7231');

  -- AB-only liability
  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    values
      (p_user_id, '2893', 'Skuld till aktieagare', 2, '28', 'liability', 'credit', 'k1', true, '7231');
  end if;

  -- =========================================================================
  -- Revenue (3xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '3001', 'Forsaljning tjanster 25%', 3, '30', 'revenue', 'credit', 'k1', true, '7310'),
    (p_user_id, '3002', 'Forsaljning varor 25%', 3, '30', 'revenue', 'credit', 'k1', true, '7310'),
    (p_user_id, '3003', 'Forsaljning tjanster 6%', 3, '30', 'revenue', 'credit', 'k1', true, '7310'),
    (p_user_id, '3100', 'Momsfri forsaljning', 3, '31', 'revenue', 'credit', 'k1', true, '7311'),
    (p_user_id, '3305', 'Forsaljning tjanst export', 3, '33', 'revenue', 'credit', 'k1', true, '7310'),
    (p_user_id, '3308', 'Forsaljning tjanst EU', 3, '33', 'revenue', 'credit', 'k1', true, '7310'),
    (p_user_id, '3900', 'Ovriga rorelseintakter', 3, '39', 'revenue', 'credit', 'k1', true, '7311'),
    (p_user_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true, '7310');

  -- =========================================================================
  -- COGS (4xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '4000', 'Varuinkop', 4, '40', 'expense', 'debit', 'k1', true, '7320');

  -- =========================================================================
  -- External expenses (5xxx-6xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '5410', 'Forbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '5460', 'Forbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6530', 'Redovisningstjanster', 6, '65', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true, '7321'),
    (p_user_id, '6991', 'Ovriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true, '7321');

  -- =========================================================================
  -- Personnel (7xxx) - AB-only salary accounts + common currency losses
  -- =========================================================================
  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    values
      (p_user_id, '7010', 'Loner', 7, '70', 'expense', 'debit', 'k1', true, '7322'),
      (p_user_id, '7210', 'Semesterloner', 7, '72', 'expense', 'debit', 'k1', true, '7322'),
      (p_user_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true, '7322');
  end if;

  -- Currency losses - Common
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '7960', 'Valutakursforluster', 7, '79', 'expense', 'debit', 'k1', true, '7360');

  -- =========================================================================
  -- Financial (8xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  values
    (p_user_id, '8310', 'Ranteintakter', 8, '83', 'revenue', 'credit', 'k1', true, '7313'),
    (p_user_id, '8410', 'Rantekostnader', 8, '84', 'expense', 'debit', 'k1', true, '7323');

end;
$$;
