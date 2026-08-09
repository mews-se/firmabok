-- Migration 7: SIE Imports
-- SIE (Standard Import Export) file import tracking and account mapping

-- =============================================================================
-- 1. sie_imports
-- =============================================================================
create table public.sie_imports (
  id                        uuid primary key default uuid_generate_v4(),
  user_id                   uuid references auth.users on delete cascade not null,
  filename                  text not null,
  file_hash                 text not null,
  org_number                text,
  company_name              text,
  sie_type                  integer not null,
  fiscal_year_start         date,
  fiscal_year_end           date,
  accounts_count            integer default 0,
  transactions_count        integer default 0,
  opening_balance_total     numeric,
  status                    text default 'pending'
                              check (status in ('pending', 'mapped', 'completed', 'failed')),
  error_message             text,
  fiscal_period_id          uuid references public.fiscal_periods (id) on delete set null,
  opening_balance_entry_id  uuid references public.journal_entries (id) on delete set null,
  imported_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (user_id, file_hash)
);

alter table public.sie_imports enable row level security;

create policy "sie_imports_select" on public.sie_imports
  for select using (auth.uid() = user_id);
create policy "sie_imports_insert" on public.sie_imports
  for insert with check (auth.uid() = user_id);
create policy "sie_imports_update" on public.sie_imports
  for update using (auth.uid() = user_id);
create policy "sie_imports_delete" on public.sie_imports
  for delete using (auth.uid() = user_id);

create index idx_sie_imports_user_status on public.sie_imports (user_id, status);

create trigger sie_imports_updated_at
  before update on public.sie_imports
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 2. sie_account_mappings
-- =============================================================================
create table public.sie_account_mappings (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users on delete cascade not null,
  source_account    text not null,
  source_name       text,
  target_account    text not null,
  confidence        numeric default 1.0,
  match_type        text default 'exact'
                      check (match_type in ('exact', 'name', 'class', 'manual')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (user_id, source_account)
);

alter table public.sie_account_mappings enable row level security;

create policy "sie_account_mappings_select" on public.sie_account_mappings
  for select using (auth.uid() = user_id);
create policy "sie_account_mappings_insert" on public.sie_account_mappings
  for insert with check (auth.uid() = user_id);
create policy "sie_account_mappings_update" on public.sie_account_mappings
  for update using (auth.uid() = user_id);
create policy "sie_account_mappings_delete" on public.sie_account_mappings
  for delete using (auth.uid() = user_id);

create index idx_sie_account_mappings_user on public.sie_account_mappings (user_id);

create trigger sie_account_mappings_updated_at
  before update on public.sie_account_mappings
  for each row execute function public.update_updated_at_column();
