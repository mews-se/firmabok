-- Migration 2: Bookkeeping Schema
-- BAS Kontoplan, fiscal periods, journal entries, mapping rules, account balances

-- =============================================================================
-- 1. chart_of_accounts (BAS Kontoplan)
-- =============================================================================
create table public.chart_of_accounts (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  account_number    text not null,
  account_name      text not null,
  account_class     integer not null,
  account_group     text,
  account_type      text not null
                      check (account_type in ('asset', 'equity', 'liability', 'revenue', 'expense')),
  normal_balance    text not null
                      check (normal_balance in ('debit', 'credit')),
  plan_type         text default 'k1'
                      check (plan_type in ('k1', 'full_bas')),
  is_active         boolean default true,
  is_system_account boolean default false,
  default_vat_code  text,
  description       text,
  sort_order        integer default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (user_id, account_number)
);

alter table public.chart_of_accounts enable row level security;

create policy "chart_of_accounts_select" on public.chart_of_accounts
  for select using (auth.uid() = user_id);
create policy "chart_of_accounts_insert" on public.chart_of_accounts
  for insert with check (auth.uid() = user_id);
create policy "chart_of_accounts_update" on public.chart_of_accounts
  for update using (auth.uid() = user_id);
create policy "chart_of_accounts_delete" on public.chart_of_accounts
  for delete using (auth.uid() = user_id);

create index idx_chart_of_accounts_user_id on public.chart_of_accounts (user_id);
create index idx_chart_of_accounts_account_number on public.chart_of_accounts (account_number);
create index idx_chart_of_accounts_account_type on public.chart_of_accounts (account_type);

create trigger chart_of_accounts_updated_at
  before update on public.chart_of_accounts
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 2. fiscal_periods
-- =============================================================================
create table public.fiscal_periods (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references auth.users on delete cascade not null,
  name                  text not null,
  period_start          date not null,
  period_end            date not null,
  is_closed             boolean default false,
  closed_at             timestamptz,
  opening_balances_set  boolean default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, period_start, period_end)
);

alter table public.fiscal_periods enable row level security;

create policy "fiscal_periods_select" on public.fiscal_periods
  for select using (auth.uid() = user_id);
create policy "fiscal_periods_insert" on public.fiscal_periods
  for insert with check (auth.uid() = user_id);
create policy "fiscal_periods_update" on public.fiscal_periods
  for update using (auth.uid() = user_id);
create policy "fiscal_periods_delete" on public.fiscal_periods
  for delete using (auth.uid() = user_id);

create index idx_fiscal_periods_user_id on public.fiscal_periods (user_id);
create index idx_fiscal_periods_dates on public.fiscal_periods (period_start, period_end);

create trigger fiscal_periods_updated_at
  before update on public.fiscal_periods
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 3. journal_entries (Verifikationer)
-- =============================================================================
create table public.journal_entries (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  fiscal_period_id  uuid references public.fiscal_periods (id) on delete restrict not null,
  voucher_number    integer not null,
  voucher_series    text default 'A',
  entry_date        date not null,
  description       text not null,
  source_type       text not null
                      check (source_type in (
                        'manual', 'bank_transaction', 'invoice_created',
                        'invoice_paid', 'credit_note', 'salary_payment',
                        'opening_balance', 'year_end'
                      )),
  source_id         uuid,
  status            text default 'draft'
                      check (status in ('draft', 'posted', 'reversed')),
  attachment_urls   text[],
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.journal_entries enable row level security;

create policy "journal_entries_select" on public.journal_entries
  for select using (auth.uid() = user_id);
create policy "journal_entries_insert" on public.journal_entries
  for insert with check (auth.uid() = user_id);
create policy "journal_entries_update" on public.journal_entries
  for update using (auth.uid() = user_id);
create policy "journal_entries_delete" on public.journal_entries
  for delete using (auth.uid() = user_id);

create index idx_journal_entries_user_id on public.journal_entries (user_id);
create index idx_journal_entries_fiscal_period_id on public.journal_entries (fiscal_period_id);
create index idx_journal_entries_entry_date on public.journal_entries (entry_date);
create index idx_journal_entries_source on public.journal_entries (source_type, source_id);
create index idx_journal_entries_status on public.journal_entries (status);

create trigger journal_entries_updated_at
  before update on public.journal_entries
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 4. journal_entry_lines
-- =============================================================================
create table public.journal_entry_lines (
  id                  uuid primary key default uuid_generate_v4(),
  journal_entry_id    uuid references public.journal_entries (id) on delete cascade not null,
  account_number      text not null,
  account_id          uuid references public.chart_of_accounts (id) on delete set null,
  debit_amount        numeric default 0,
  credit_amount       numeric default 0,
  currency            text default 'SEK',
  amount_in_currency  numeric,
  exchange_rate       numeric,
  line_description    text,
  sort_order          integer default 0,
  created_at          timestamptz not null default now()
);

alter table public.journal_entry_lines enable row level security;

create policy "journal_entry_lines_select" on public.journal_entry_lines
  for select using (
    exists (
      select 1 from public.journal_entries
      where journal_entries.id = journal_entry_lines.journal_entry_id
        and journal_entries.user_id = auth.uid()
    )
  );
create policy "journal_entry_lines_insert" on public.journal_entry_lines
  for insert with check (
    exists (
      select 1 from public.journal_entries
      where journal_entries.id = journal_entry_lines.journal_entry_id
        and journal_entries.user_id = auth.uid()
    )
  );
create policy "journal_entry_lines_update" on public.journal_entry_lines
  for update using (
    exists (
      select 1 from public.journal_entries
      where journal_entries.id = journal_entry_lines.journal_entry_id
        and journal_entries.user_id = auth.uid()
    )
  );
create policy "journal_entry_lines_delete" on public.journal_entry_lines
  for delete using (
    exists (
      select 1 from public.journal_entries
      where journal_entries.id = journal_entry_lines.journal_entry_id
        and journal_entries.user_id = auth.uid()
    )
  );

create index idx_journal_entry_lines_entry_id on public.journal_entry_lines (journal_entry_id);
create index idx_journal_entry_lines_account on public.journal_entry_lines (account_number);

-- =============================================================================
-- 5. mapping_rules
-- =============================================================================
create table public.mapping_rules (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid references auth.users on delete cascade,
  rule_name                   text not null,
  rule_type                   text not null
                                check (rule_type in ('mcc_code', 'merchant_name', 'description_pattern', 'amount_threshold', 'combined')),
  priority                    integer default 100,
  mcc_codes                   integer[],
  merchant_pattern            text,
  description_pattern         text,
  amount_min                  numeric,
  amount_max                  numeric,
  debit_account               text,
  credit_account              text,
  vat_treatment               text,
  vat_debit_account           text,
  vat_credit_account          text,
  risk_level                  text default 'LOW',
  default_private             boolean default false,
  requires_review             boolean default false,
  confidence_score            numeric default 0.5,
  capitalization_threshold    numeric,
  capitalized_debit_account   text,
  is_active                   boolean default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.mapping_rules enable row level security;

create policy "mapping_rules_select" on public.mapping_rules
  for select using (auth.uid() = user_id or user_id is null);
create policy "mapping_rules_insert" on public.mapping_rules
  for insert with check (auth.uid() = user_id);
create policy "mapping_rules_update" on public.mapping_rules
  for update using (auth.uid() = user_id);
create policy "mapping_rules_delete" on public.mapping_rules
  for delete using (auth.uid() = user_id);

create index idx_mapping_rules_user_id on public.mapping_rules (user_id);
create index idx_mapping_rules_rule_type on public.mapping_rules (rule_type);
create index idx_mapping_rules_priority on public.mapping_rules (priority);

create trigger mapping_rules_updated_at
  before update on public.mapping_rules
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 6. account_balances (cached balances)
-- =============================================================================
create table public.account_balances (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  fiscal_period_id  uuid references public.fiscal_periods (id) on delete cascade not null,
  account_number    text not null,
  account_id        uuid references public.chart_of_accounts (id) on delete set null,
  opening_debit     numeric default 0,
  opening_credit    numeric default 0,
  period_debit      numeric default 0,
  period_credit     numeric default 0,
  closing_debit     numeric default 0,
  closing_credit    numeric default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (user_id, fiscal_period_id, account_number)
);

alter table public.account_balances enable row level security;

create policy "account_balances_select" on public.account_balances
  for select using (auth.uid() = user_id);
create policy "account_balances_insert" on public.account_balances
  for insert with check (auth.uid() = user_id);
create policy "account_balances_update" on public.account_balances
  for update using (auth.uid() = user_id);
create policy "account_balances_delete" on public.account_balances
  for delete using (auth.uid() = user_id);

create index idx_account_balances_user_id on public.account_balances (user_id);
create index idx_account_balances_fiscal_period on public.account_balances (fiscal_period_id);
create index idx_account_balances_account on public.account_balances (account_number);

create trigger account_balances_updated_at
  before update on public.account_balances
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- Add FK from transactions.journal_entry_id -> journal_entries
-- =============================================================================
alter table public.transactions
  add constraint fk_transactions_journal_entry
  foreign key (journal_entry_id) references public.journal_entries (id) on delete set null;

create index idx_transactions_journal_entry_id on public.transactions (journal_entry_id);
