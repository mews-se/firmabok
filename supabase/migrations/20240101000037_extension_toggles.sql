-- Extension Toggles
-- Tracks which extensions each user has enabled.

create table public.extension_toggles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  sector_slug     text not null,
  extension_slug  text not null,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint extension_toggles_unique unique (user_id, sector_slug, extension_slug)
);

alter table public.extension_toggles enable row level security;

create policy "extension_toggles_select" on public.extension_toggles
  for select using (auth.uid() = user_id);
create policy "extension_toggles_insert" on public.extension_toggles
  for insert with check (auth.uid() = user_id);
create policy "extension_toggles_update" on public.extension_toggles
  for update using (auth.uid() = user_id);
create policy "extension_toggles_delete" on public.extension_toggles
  for delete using (auth.uid() = user_id);

create index extension_toggles_user_idx
  on public.extension_toggles (user_id);
create index extension_toggles_user_sector_idx
  on public.extension_toggles (user_id, sector_slug, extension_slug);

create trigger extension_toggles_updated_at
  before update on public.extension_toggles
  for each row execute function public.update_updated_at_column();

-- Add sector_slug to company_settings
alter table public.company_settings
  add column if not exists sector_slug text;
