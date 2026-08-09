-- Migration 10: Module Toggles
-- Per-user module enable/disable state

-- =============================================================================
-- 1. module_toggles
-- =============================================================================
create table public.module_toggles (
  id            uuid primary key default extensions.uuid_generate_v4(),
  user_id       uuid not null references auth.users on delete cascade,
  sector_slug   text not null,
  module_slug   text not null,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint module_toggles_unique unique (user_id, sector_slug, module_slug)
);

alter table public.module_toggles enable row level security;

-- RLS policies
create policy "module_toggles_select" on public.module_toggles
  for select using (auth.uid() = user_id);
create policy "module_toggles_insert" on public.module_toggles
  for insert with check (auth.uid() = user_id);
create policy "module_toggles_update" on public.module_toggles
  for update using (auth.uid() = user_id);
create policy "module_toggles_delete" on public.module_toggles
  for delete using (auth.uid() = user_id);

-- Index for fast lookups
create index module_toggles_user_id_idx on public.module_toggles (user_id);
create index module_toggles_sector_module_idx on public.module_toggles (user_id, sector_slug, module_slug);

-- updated_at trigger
create trigger module_toggles_updated_at
  before update on public.module_toggles
  for each row execute function public.update_updated_at_column();
