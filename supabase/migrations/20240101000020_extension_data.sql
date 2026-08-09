-- ============================================================
-- Extension Data Table
-- Generic key-value store for extensions
-- ============================================================

create table if not exists extension_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  extension_id text not null,
  key text not null,
  value jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, extension_id, key)
);

-- RLS: users can only access their own extension data
alter table extension_data enable row level security;

create policy "Users can select own extension data"
  on extension_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own extension data"
  on extension_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own extension data"
  on extension_data for update
  using (auth.uid() = user_id);

create policy "Users can delete own extension data"
  on extension_data for delete
  using (auth.uid() = user_id);

-- Indexes
create index if not exists idx_extension_data_user_id on extension_data (user_id);
create index if not exists idx_extension_data_user_ext_key on extension_data (user_id, extension_id, key);

-- Auto-update updated_at
create trigger set_updated_at_extension_data
  before update on extension_data
  for each row execute function update_updated_at_column();

-- Audit trigger
create trigger audit_extension_data
  after insert or update or delete on extension_data
  for each row execute function write_audit_log();
