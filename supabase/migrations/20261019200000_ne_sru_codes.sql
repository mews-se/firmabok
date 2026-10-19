-- The SRU code on a chart account is the NE-bilaga field its balance sums
-- into, and the SIE export writes it as #SRU. The codes seeded so far (73xx
-- for the result accounts, INK2-style 72xx/73xx for the balance sheet) match
-- no NE field, and some are the NE code of another row: 1930 carried 7212,
-- which is B4 Maskiner och inventarier.
--
-- The mapping is BAS-kontogruppen's kopplingstabell NE_EJ_K1, as in
-- lib/bookkeeping/bas-data/sru-mapping.ts. In the groups BAS marks (+) and (-)
-- a credit account takes R4 (7403) and a debit account R8 (7503); SIE allows
-- one of the two and the receiving program moves the amount by sign.
--
-- Two parts: (1) redefine seed_chart_of_accounts with the NE codes, so new
-- companies are right from the start; the enskild firma equity accounts get
-- B10 (7300) instead of NULL. (2) Update existing rows, but only where the
-- code is one of the 28 this program generated before (the seed, the BAS
-- reference data and the 20240101000021 backfill) or NULL on a seeded
-- 2010/2013/2018, so a code entered by hand outside that set is kept.
--
-- The function body is otherwise identical to 20260731090000. Signature
-- unchanged, so CREATE OR REPLACE keeps the EXECUTE grant.

CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid, p_entity_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true, '7250'),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true, '7280'),
    (v_user_id, p_company_id, '1930', 'Företagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true, '7280'),
    (v_user_id, p_company_id, '1940', 'Övriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true, '7280');

  -- Equity (2xxx)
  IF p_entity_type = 'enskild_firma' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true, '7300'),
      (v_user_id, p_company_id, '2013', 'Övriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true, '7300'),
      (v_user_id, p_company_id, '2018', 'Övriga egna insättningar', 2, '20', 'equity', 'credit', 'k1', true, '7300');
  END IF;

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2099', 'Årets resultat', 2, '20', 'equity', 'credit', 'k1', true, NULL);
  END IF;

  -- Liabilities (2xxx) - BAS 2026 VAT account labels
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantörsskulder', 2, '24', 'liability', 'credit', 'k1', true, '7382'),
    (v_user_id, p_company_id, '2611', 'Utgående moms försäljning inom Sverige, 25%', 2, '26', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2621', 'Utgående moms försäljning inom Sverige, 12%', 2, '26', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2631', 'Utgående moms försäljning inom Sverige, 6%', 2, '26', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2641', 'Debiterad ingående moms', 2, '26', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto för moms', 2, '26', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true, '7383'),
    (v_user_id, p_company_id, '2731', 'Avräkning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true, '7383');

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieägare', 2, '28', 'liability', 'credit', 'k1', true, '7383');
  END IF;

  -- Revenue (3xxx). 3001/3002 carry the official BAS 2026 names: 3001 takes
  -- ALL 25% revenue and 3002 is the 12% account (invoice booking, category
  -- mapping and default_vat_rate all treat it as 12%), so the name must say
  -- so.
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '3001', 'Försäljning inom Sverige, 25 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7400'),
    (v_user_id, p_company_id, '3002', 'Försäljning inom Sverige, 12 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7400'),
    (v_user_id, p_company_id, '3100', 'Momsfri försäljning', 3, '31', 'revenue', 'credit', 'k1', true, '7401'),
    (v_user_id, p_company_id, '3900', 'Övriga rörelseintäkter', 3, '39', 'revenue', 'credit', 'k1', true, '7401'),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true, '7401');

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinköp', 4, '40', 'expense', 'debit', 'k1', true, '7500');

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '5410', 'Förbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '5460', 'Förbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6530', 'Redovisningstjänster', 6, '65', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true, '7501'),
    (v_user_id, p_company_id, '6991', 'Övriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true, '7501');

  -- Personnel (7xxx). BAS names: 7010 kollektivanställda, 7210 tjänstemän.
  -- The payroll engine books gross salaries to 7210 and vacation pay to
  -- 7285 (auto-created with its BAS name when first needed).
  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '7010', 'Löner till kollektivanställda', 7, '70', 'expense', 'debit', 'k1', true, '7502'),
      (v_user_id, p_company_id, '7210', 'Löner till tjänstemän', 7, '72', 'expense', 'debit', 'k1', true, '7502'),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true, '7502');
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursförluster', 7, '79', 'expense', 'debit', 'k1', true, '7503');

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ränteintäkter', 8, '83', 'revenue', 'credit', 'k1', true, '7403'),
    (v_user_id, p_company_id, '8410', 'Räntekostnader', 8, '84', 'expense', 'debit', 'k1', true, '7503');
END;
$$;

WITH ne AS (
  SELECT id,
    CASE
      WHEN account_number BETWEEN '8020' AND '8039'
        OR account_number BETWEEN '8120' AND '8139'
        OR account_number BETWEEN '8220' AND '8249'
        OR account_number BETWEEN '8290' AND '8299'
        OR account_number BETWEEN '8320' AND '8339'
        OR account_number BETWEEN '8350' AND '8359'
        OR account_number BETWEEN '8430' AND '8439'
        OR account_number BETWEEN '8450' AND '8459'
        OR account_number BETWEEN '8490' AND '8499'
        OR account_number BETWEEN '8810' AND '8819'
        OR account_number BETWEEN '8860' AND '8869'
        OR account_number BETWEEN '8880' AND '8899'
        THEN CASE WHEN normal_balance = 'debit' THEN '7503' ELSE '7403' END
      WHEN account_number BETWEEN '1000' AND '1099' THEN '7200'
      WHEN account_number BETWEEN '1130' AND '1149'
        OR account_number BETWEEN '1180' AND '1189'
        OR account_number = '1291' THEN '7211'
      WHEN account_number BETWEEN '1100' AND '1199' THEN '7210'
      WHEN account_number BETWEEN '1200' AND '1299' THEN '7212'
      WHEN account_number BETWEEN '1300' AND '1399' THEN '7213'
      WHEN account_number BETWEEN '1400' AND '1499' THEN '7240'
      WHEN account_number BETWEEN '1500' AND '1599' THEN '7250'
      WHEN account_number BETWEEN '1600' AND '1899' THEN '7260'
      WHEN account_number BETWEEN '1900' AND '1999' THEN '7280'
      WHEN account_number BETWEEN '2010' AND '2019'
        OR account_number BETWEEN '2050' AND '2059' THEN '7300'
      WHEN account_number BETWEEN '2100' AND '2199' THEN '7320'
      WHEN account_number BETWEEN '2200' AND '2299' THEN '7330'
      WHEN account_number BETWEEN '2300' AND '2399'
        OR account_number BETWEEN '2410' AND '2419'
        OR account_number BETWEEN '2480' AND '2489' THEN '7380'
      WHEN account_number BETWEEN '2440' AND '2449'
        OR account_number BETWEEN '2460' AND '2479' THEN '7382'
      WHEN account_number BETWEEN '2420' AND '2439'
        OR account_number BETWEEN '2450' AND '2459'
        OR account_number BETWEEN '2490' AND '2499'
        OR account_number BETWEEN '2600' AND '2999' THEN '7383'
      WHEN account_number = '3100'
        OR account_number BETWEEN '3900' AND '3999' THEN '7401'
      WHEN account_number BETWEEN '3000' AND '3799' THEN '7400'
      WHEN account_number BETWEEN '3800' AND '3899'
        OR account_number BETWEEN '8010' AND '8019'
        OR account_number BETWEEN '8110' AND '8119'
        OR account_number BETWEEN '8200' AND '8219'
        OR account_number BETWEEN '8250' AND '8269'
        OR account_number BETWEEN '8300' AND '8319'
        OR account_number BETWEEN '8340' AND '8349'
        OR account_number BETWEEN '8360' AND '8369'
        OR account_number BETWEEN '8390' AND '8399'
        OR account_number BETWEEN '8440' AND '8449' THEN '7403'
      WHEN account_number BETWEEN '4000' AND '4999' THEN '7500'
      WHEN account_number BETWEEN '5000' AND '6999' THEN '7501'
      WHEN account_number BETWEEN '7000' AND '7699' THEN '7502'
      WHEN account_number BETWEEN '7740' AND '7749'
        OR account_number BETWEEN '7790' AND '7799'
        OR account_number BETWEEN '7900' AND '7999'
        OR account_number BETWEEN '8070' AND '8089'
        OR account_number BETWEEN '8170' AND '8189'
        OR account_number BETWEEN '8270' AND '8289'
        OR account_number BETWEEN '8370' AND '8389'
        OR account_number BETWEEN '8400' AND '8429'
        OR account_number BETWEEN '8460' AND '8469'
        OR account_number BETWEEN '8480' AND '8489'
        OR account_number BETWEEN '8900' AND '8989' THEN '7503'
      WHEN account_number BETWEEN '7720' AND '7729'
        OR account_number BETWEEN '7770' AND '7779'
        OR account_number BETWEEN '7820' AND '7829'
        OR account_number BETWEEN '7840' AND '7849' THEN '7504'
      WHEN account_number BETWEEN '7710' AND '7719'
        OR account_number BETWEEN '7730' AND '7739'
        OR account_number BETWEEN '7760' AND '7769'
        OR account_number BETWEEN '7780' AND '7789'
        OR account_number BETWEEN '7810' AND '7819'
        OR account_number BETWEEN '7830' AND '7839'
        OR account_number BETWEEN '8850' AND '8859' THEN '7505'
      WHEN account_number BETWEEN '8990' AND '8999' THEN '7440'
    END AS code
  FROM public.chart_of_accounts
  WHERE sru_code IN ('7201', '7202', '7203', '7210', '7211', '7212', '7215',
                     '7220', '7221', '7222', '7230', '7231', '7310', '7311',
                     '7312', '7313', '7320', '7321', '7322', '7323', '7324',
                     '7325', '7330', '7340', '7350', '7360', '7370', '7380')
     OR (sru_code IS NULL
         AND is_system_account
         AND account_number IN ('2010', '2013', '2018'))
)
UPDATE public.chart_of_accounts c
SET sru_code = ne.code, updated_at = now()
FROM ne
WHERE c.id = ne.id
  AND c.sru_code IS DISTINCT FROM ne.code;

NOTIFY pgrst, 'reload schema';
