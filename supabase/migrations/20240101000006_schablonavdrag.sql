-- Migration 6: Schablonavdrag - Mileage Entries
-- Mileage deduction tracking (milersattning / korjournal)

-- =============================================================================
-- mileage_entries
-- =============================================================================
create table public.mileage_entries (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references auth.users on delete cascade not null,
  date            date not null,
  distance_km     numeric not null,
  purpose         text not null,
  from_location   text,
  to_location     text,
  rate_per_km     numeric default 2.50,
  total_deduction numeric not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.mileage_entries enable row level security;

create policy "mileage_entries_select" on public.mileage_entries
  for select using (auth.uid() = user_id);
create policy "mileage_entries_insert" on public.mileage_entries
  for insert with check (auth.uid() = user_id);
create policy "mileage_entries_update" on public.mileage_entries
  for update using (auth.uid() = user_id);
create policy "mileage_entries_delete" on public.mileage_entries
  for delete using (auth.uid() = user_id);

create index idx_mileage_entries_user_date on public.mileage_entries (user_id, date);

create trigger mileage_entries_updated_at
  before update on public.mileage_entries
  for each row execute function public.update_updated_at_column();
