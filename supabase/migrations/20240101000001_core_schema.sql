-- Migration 1: Core Schema
-- Profiles, company_settings, bank_connections, customers, invoices,
-- invoice_items, transactions, salary_payments, tax_rates

-- =============================================================================
-- Extensions
-- =============================================================================
create extension if not exists "uuid-ossp" with schema extensions;

-- =============================================================================
-- Trigger function: update_updated_at_column (reused across all migrations)
-- =============================================================================
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =============================================================================
-- 1. profiles
-- =============================================================================
create table public.profiles (
  id              uuid primary key references auth.users on delete cascade,
  email           text,
  full_name       text,
  avatar_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at_column();

-- Auto-create profile on new user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 2. company_settings
-- =============================================================================
create table public.company_settings (
  id                       uuid primary key default uuid_generate_v4(),
  user_id                  uuid references auth.users on delete cascade unique not null,
  entity_type              text check (entity_type in ('enskild_firma', 'aktiebolag')),
  company_name             text,
  org_number               text,
  vat_number               text,
  address_line1            text,
  address_line2            text,
  postal_code              text,
  city                     text,
  country                  text default 'SE',
  phone                    text,
  email                    text,
  website                  text,
  bankgiro                 text,
  plusgiro                  text,
  iban                     text,
  bic                      text,
  f_skatt                  boolean default true,
  vat_registered           boolean default false,
  moms_period              text check (moms_period in ('monthly', 'quarterly', 'yearly')),
  fiscal_year_start_month  integer default 1,
  invoice_prefix           text,
  next_invoice_number      integer default 1,
  invoice_default_days     integer default 30,
  logo_url                 text,
  onboarding_complete      boolean default false,
  schablon_mileage_rate    numeric default 2.50,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.company_settings enable row level security;

create policy "company_settings_select" on public.company_settings
  for select using (auth.uid() = user_id);
create policy "company_settings_insert" on public.company_settings
  for insert with check (auth.uid() = user_id);
create policy "company_settings_update" on public.company_settings
  for update using (auth.uid() = user_id);
create policy "company_settings_delete" on public.company_settings
  for delete using (auth.uid() = user_id);

create index idx_company_settings_user_id on public.company_settings (user_id);

create trigger company_settings_updated_at
  before update on public.company_settings
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 3. bank_connections
-- =============================================================================
create table public.bank_connections (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  provider          text not null default 'enablebanking',
  bank_name         text,
  session_id        text,
  status            text default 'pending'
                      check (status in ('pending', 'active', 'expired', 'error', 'revoked')),
  consent_expires   timestamptz,
  accounts_data     jsonb,
  error_message     text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.bank_connections enable row level security;

create policy "bank_connections_select" on public.bank_connections
  for select using (auth.uid() = user_id);
create policy "bank_connections_insert" on public.bank_connections
  for insert with check (auth.uid() = user_id);
create policy "bank_connections_update" on public.bank_connections
  for update using (auth.uid() = user_id);
create policy "bank_connections_delete" on public.bank_connections
  for delete using (auth.uid() = user_id);

create index idx_bank_connections_user_id on public.bank_connections (user_id);

create trigger bank_connections_updated_at
  before update on public.bank_connections
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 4. customers
-- =============================================================================
create table public.customers (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references auth.users on delete cascade not null,
  name            text not null,
  org_number      text,
  vat_number      text,
  email           text,
  phone           text,
  address_line1   text,
  postal_code     text,
  city            text,
  country         text default 'SE',
  is_international boolean default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.customers enable row level security;

create policy "customers_select" on public.customers
  for select using (auth.uid() = user_id);
create policy "customers_insert" on public.customers
  for insert with check (auth.uid() = user_id);
create policy "customers_update" on public.customers
  for update using (auth.uid() = user_id);
create policy "customers_delete" on public.customers
  for delete using (auth.uid() = user_id);

create index idx_customers_user_id on public.customers (user_id);

create trigger customers_updated_at
  before update on public.customers
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 5. invoices
-- =============================================================================
create table public.invoices (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references auth.users on delete cascade not null,
  customer_id           uuid references public.customers (id) on delete set null,
  invoice_number        text not null,
  invoice_date          date not null,
  due_date              date not null,
  status                text default 'draft'
                          check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited')),
  currency              text default 'SEK',
  exchange_rate         numeric,
  exchange_rate_date    date,
  subtotal              numeric default 0,
  subtotal_sek          numeric default 0,
  vat_amount            numeric default 0,
  vat_amount_sek        numeric default 0,
  total                 numeric default 0,
  total_sek             numeric default 0,
  vat_treatment         text default 'standard_25',
  vat_rate              numeric default 25,
  moms_ruta             text,
  your_reference        text,
  our_reference         text,
  notes                 text,
  reverse_charge_text   text,
  credited_invoice_id   uuid references public.invoices (id) on delete set null,
  paid_at               timestamptz,
  paid_amount           numeric,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, invoice_number)
);

alter table public.invoices enable row level security;

create policy "invoices_select" on public.invoices
  for select using (auth.uid() = user_id);
create policy "invoices_insert" on public.invoices
  for insert with check (auth.uid() = user_id);
create policy "invoices_update" on public.invoices
  for update using (auth.uid() = user_id);
create policy "invoices_delete" on public.invoices
  for delete using (auth.uid() = user_id);

create index idx_invoices_user_id on public.invoices (user_id);
create index idx_invoices_status on public.invoices (status);
create index idx_invoices_due_date on public.invoices (due_date);

create trigger invoices_updated_at
  before update on public.invoices
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 6. invoice_items
-- =============================================================================
create table public.invoice_items (
  id          uuid primary key default uuid_generate_v4(),
  invoice_id  uuid references public.invoices (id) on delete cascade not null,
  sort_order  integer default 0,
  description text not null,
  quantity    numeric default 1,
  unit        text default 'st',
  unit_price  numeric default 0,
  line_total  numeric default 0,
  created_at  timestamptz not null default now()
);

alter table public.invoice_items enable row level security;

create policy "invoice_items_select" on public.invoice_items
  for select using (
    exists (
      select 1 from public.invoices
      where invoices.id = invoice_items.invoice_id
        and invoices.user_id = auth.uid()
    )
  );
create policy "invoice_items_insert" on public.invoice_items
  for insert with check (
    exists (
      select 1 from public.invoices
      where invoices.id = invoice_items.invoice_id
        and invoices.user_id = auth.uid()
    )
  );
create policy "invoice_items_update" on public.invoice_items
  for update using (
    exists (
      select 1 from public.invoices
      where invoices.id = invoice_items.invoice_id
        and invoices.user_id = auth.uid()
    )
  );
create policy "invoice_items_delete" on public.invoice_items
  for delete using (
    exists (
      select 1 from public.invoices
      where invoices.id = invoice_items.invoice_id
        and invoices.user_id = auth.uid()
    )
  );

create index idx_invoice_items_invoice_id on public.invoice_items (invoice_id);

-- =============================================================================
-- 7. transactions
-- =============================================================================
create table public.transactions (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references auth.users on delete cascade not null,
  bank_connection_id    uuid references public.bank_connections (id) on delete set null,
  external_id           text,
  date                  date not null,
  description           text not null,
  amount                numeric not null,
  currency              text default 'SEK',
  amount_sek            numeric,
  exchange_rate         numeric,
  exchange_rate_date    date,
  category              text default 'uncategorized',
  is_business           boolean,
  invoice_id            uuid references public.invoices (id) on delete set null,
  potential_invoice_id  uuid references public.invoices (id) on delete set null,
  journal_entry_id      uuid,
  mcc_code              integer,
  merchant_name         text,
  receipt_id            uuid,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, external_id)
);

alter table public.transactions enable row level security;

create policy "transactions_select" on public.transactions
  for select using (auth.uid() = user_id);
create policy "transactions_insert" on public.transactions
  for insert with check (auth.uid() = user_id);
create policy "transactions_update" on public.transactions
  for update using (auth.uid() = user_id);
create policy "transactions_delete" on public.transactions
  for delete using (auth.uid() = user_id);

create index idx_transactions_user_id on public.transactions (user_id);
create index idx_transactions_date on public.transactions (date);
create index idx_transactions_external_id on public.transactions (external_id);
create index idx_transactions_category on public.transactions (category);

create trigger transactions_updated_at
  before update on public.transactions
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 8. salary_payments
-- =============================================================================
create table public.salary_payments (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  gross_amount      numeric not null,
  net_amount        numeric not null,
  employer_tax      numeric not null,
  preliminary_tax   numeric not null,
  payment_date      date not null,
  period_start      date not null,
  period_end        date not null,
  status            text default 'planned'
                      check (status in ('planned', 'paid', 'reported')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.salary_payments enable row level security;

create policy "salary_payments_select" on public.salary_payments
  for select using (auth.uid() = user_id);
create policy "salary_payments_insert" on public.salary_payments
  for insert with check (auth.uid() = user_id);
create policy "salary_payments_update" on public.salary_payments
  for update using (auth.uid() = user_id);
create policy "salary_payments_delete" on public.salary_payments
  for delete using (auth.uid() = user_id);

create index idx_salary_payments_user_id on public.salary_payments (user_id);

create trigger salary_payments_updated_at
  before update on public.salary_payments
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 9. tax_rates (read-only reference table)
-- =============================================================================
create table public.tax_rates (
  id          uuid primary key default uuid_generate_v4(),
  rate_type   text not null,
  rate        numeric not null,
  valid_from  date not null,
  valid_to    date,
  description text
);

alter table public.tax_rates enable row level security;

create policy "tax_rates_select" on public.tax_rates
  for select to authenticated using (true);

-- Seed current Swedish tax rates
insert into public.tax_rates (rate_type, rate, valid_from, description) values
  ('egenavgifter',        28.97, '2024-01-01', 'Egenavgifter for enskild firma'),
  ('bolagsskatt',         20.6,  '2019-01-01', 'Bolagsskatt (corporate tax)'),
  ('arbetsgivaravgifter', 31.42, '2024-01-01', 'Arbetsgivaravgifter (employer social contributions)');
