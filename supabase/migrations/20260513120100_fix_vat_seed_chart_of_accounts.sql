-- Fix seed_chart_of_accounts: VAT account labels did not match BAS 2026.
--
-- The previous seed (introduced in 20260330130000_multi_tenant_company_refactor.sql)
-- created the 26xx output VAT accounts with the wrong account numbers:
--
--   2611 labelled "Utgaende moms 12%"   ← per BAS, 2611 is 25%
--   2612 labelled "Utgaende moms 6%"    ← per BAS, 2612 is "egna uttag 25%"; 6% is 2631
--   2610 was seeded as plain "25%"      ← 2610 is a collective parent in BAS, the engine
--                                          does not route to it
--
-- Per BAS 2026 (BAS-intressenternas Förening) and the rest of this codebase
-- (lib/bookkeeping/bas-data, lib/bookkeeping/account-descriptions.ts, the VAT
-- declaration mapping, and the engine itself), the correct accounts are:
--
--   2611  Utgaende moms forsaljning inom Sverige, 25%
--   2621  Utgaende moms forsaljning inom Sverige, 12%
--   2631  Utgaende moms forsaljning inom Sverige,  6%
--
-- This migration only fixes the seed function. Existing companies with the bad
-- seed are intentionally NOT backfilled here.

DROP FUNCTION IF EXISTS public.seed_chart_of_accounts(uuid, text);

CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid, p_entity_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_account_count integer;
  v_user_id uuid;
BEGIN
  SELECT created_by INTO v_user_id FROM public.companies WHERE id = p_company_id;

  SELECT count(*) INTO v_account_count
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id;

  IF v_account_count > 0 THEN
    RETURN;
  END IF;

  -- Assets (1xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1930', 'Foretagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1940', 'Ovriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true);

  -- Equity (2xxx)
  IF p_entity_type = 'enskild_firma' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2013', 'Ovriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2018', 'Ovriga egna insattningar', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2099', 'Arets resultat', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  -- Liabilities (2xxx) — corrected VAT account labels per BAS 2026
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantorsskulder', 2, '24', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2611', 'Utgaende moms forsaljning inom Sverige, 25%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2621', 'Utgaende moms forsaljning inom Sverige, 12%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2631', 'Utgaende moms forsaljning inom Sverige,  6%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2641', 'Debiterad ingaende moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto for moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2731', 'Avrakning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true);

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieagare', 2, '28', 'liability', 'credit', 'k1', true);
  END IF;

  -- Revenue (3xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '3001', 'Forsaljning tjanster 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3002', 'Forsaljning varor 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3100', 'Momsfri forsaljning', 3, '31', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3900', 'Ovriga rorelseintakter', 3, '39', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true);

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinkop', 4, '40', 'expense', 'debit', 'k1', true);

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5410', 'Forbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5460', 'Forbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6530', 'Redovisningstjanster', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6991', 'Ovriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true);

  -- Personnel (7xxx)
  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '7010', 'Loner', 7, '70', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7210', 'Semesterloner', 7, '72', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true);
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursforluster', 7, '79', 'expense', 'debit', 'k1', true);

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ranteintakter', 8, '83', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '8410', 'Rantekostnader', 8, '84', 'expense', 'debit', 'k1', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
