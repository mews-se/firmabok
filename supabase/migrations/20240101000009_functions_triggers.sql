-- Migration 9: Functions & Triggers
-- seed_chart_of_accounts (BAS Kontoplan K1) and next_voucher_number

-- =============================================================================
-- Function: seed_chart_of_accounts
-- Seeds the standard Swedish BAS Kontoplan (K1) for a new user.
-- Handles both enskild_firma (EF) and aktiebolag (AB) entity types.
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
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true),
    (p_user_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true),
    (p_user_id, '1930', 'Foretagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true),
    (p_user_id, '1940', 'Ovriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true);

  -- =========================================================================
  -- Equity (2xxx) - Entity-type dependent
  -- =========================================================================
  if p_entity_type = 'enskild_firma' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    values
      (p_user_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true),
      (p_user_id, '2013', 'Ovriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true),
      (p_user_id, '2018', 'Ovriga egna insattningar', 2, '20', 'equity', 'credit', 'k1', true);
  end if;

  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    values
      (p_user_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true),
      (p_user_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true),
      (p_user_id, '2099', 'Arets resultat', 2, '20', 'equity', 'credit', 'k1', true);
  end if;

  -- =========================================================================
  -- Liabilities (2xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '2440', 'Leverantorsskulder', 2, '24', 'liability', 'credit', 'k1', true),
    (p_user_id, '2610', 'Utgaende moms 25%', 2, '26', 'liability', 'credit', 'k1', true),
    (p_user_id, '2611', 'Utgaende moms 12%', 2, '26', 'liability', 'credit', 'k1', true),
    (p_user_id, '2612', 'Utgaende moms 6%', 2, '26', 'liability', 'credit', 'k1', true),
    (p_user_id, '2641', 'Debiterad ingaende moms', 2, '26', 'liability', 'credit', 'k1', true),
    (p_user_id, '2650', 'Redovisningskonto for moms', 2, '26', 'liability', 'credit', 'k1', true),
    (p_user_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true),
    (p_user_id, '2731', 'Avrakning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true);

  -- AB-only liability
  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    values
      (p_user_id, '2893', 'Skuld till aktieagare', 2, '28', 'liability', 'credit', 'k1', true);
  end if;

  -- =========================================================================
  -- Revenue (3xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '3001', 'Forsaljning tjanster 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (p_user_id, '3002', 'Forsaljning varor 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (p_user_id, '3100', 'Momsfri forsaljning', 3, '31', 'revenue', 'credit', 'k1', true),
    (p_user_id, '3900', 'Ovriga rorelseintakter', 3, '39', 'revenue', 'credit', 'k1', true),
    (p_user_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true);

  -- =========================================================================
  -- COGS (4xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '4000', 'Varuinkop', 4, '40', 'expense', 'debit', 'k1', true);

  -- =========================================================================
  -- External expenses (5xxx-6xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true),
    (p_user_id, '5410', 'Forbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true),
    (p_user_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true),
    (p_user_id, '5460', 'Forbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true),
    (p_user_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true),
    (p_user_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true),
    (p_user_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true),
    (p_user_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true),
    (p_user_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true),
    (p_user_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true),
    (p_user_id, '6530', 'Redovisningstjanster', 6, '65', 'expense', 'debit', 'k1', true),
    (p_user_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true),
    (p_user_id, '6991', 'Ovriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true);

  -- =========================================================================
  -- Personnel (7xxx) - AB-only salary accounts + common currency losses
  -- =========================================================================
  if p_entity_type = 'aktiebolag' then
    insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    values
      (p_user_id, '7010', 'Loner', 7, '70', 'expense', 'debit', 'k1', true),
      (p_user_id, '7210', 'Semesterloner', 7, '72', 'expense', 'debit', 'k1', true),
      (p_user_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true);
  end if;

  -- Currency losses - Common
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '7960', 'Valutakursforluster', 7, '79', 'expense', 'debit', 'k1', true);

  -- =========================================================================
  -- Financial (8xxx) - Common
  -- =========================================================================
  insert into public.chart_of_accounts (user_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  values
    (p_user_id, '8310', 'Ranteintakter', 8, '83', 'revenue', 'credit', 'k1', true),
    (p_user_id, '8410', 'Rantekostnader', 8, '84', 'expense', 'debit', 'k1', true);

end;
$$;

-- =============================================================================
-- Function: next_voucher_number
-- Returns the next sequential voucher number for a given fiscal period + series
-- =============================================================================
create or replace function public.next_voucher_number(
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_series text default 'A'
)
returns integer
language plpgsql
security definer
as $$
declare
  v_next integer;
begin
  select coalesce(max(voucher_number), 0) + 1
  into v_next
  from public.journal_entries
  where user_id = p_user_id
    and fiscal_period_id = p_fiscal_period_id
    and voucher_series = p_series;

  return v_next;
end;
$$;

-- =============================================================================
-- Grants
-- =============================================================================
grant execute on function public.seed_chart_of_accounts(uuid, text) to authenticated;
grant execute on function public.next_voucher_number(uuid, uuid, text) to authenticated;
