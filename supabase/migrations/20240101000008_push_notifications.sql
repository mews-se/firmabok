-- Migration 8: Push Notifications
-- Web push subscriptions, per-user notification preferences, delivery logging

-- =============================================================================
-- 1. push_subscriptions
-- =============================================================================
create table public.push_subscriptions (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users on delete cascade not null,
  endpoint      text unique not null,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  is_active     boolean default true,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select" on public.push_subscriptions
  for select using (auth.uid() = user_id);
create policy "push_subscriptions_insert" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);
create policy "push_subscriptions_update" on public.push_subscriptions
  for update using (auth.uid() = user_id);
create policy "push_subscriptions_delete" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

create index idx_push_subscriptions_user_active on public.push_subscriptions (user_id, is_active);

-- =============================================================================
-- 2. notification_settings
-- =============================================================================
create table public.notification_settings (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid references auth.users on delete cascade unique not null,
  tax_deadlines_enabled       boolean default true,
  invoice_reminders_enabled   boolean default true,
  push_enabled                boolean default true,
  email_enabled               boolean default true,
  quiet_start                 text default '21:00',
  quiet_end                   text default '08:00',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.notification_settings enable row level security;

create policy "notification_settings_select" on public.notification_settings
  for select using (auth.uid() = user_id);
create policy "notification_settings_insert" on public.notification_settings
  for insert with check (auth.uid() = user_id);
create policy "notification_settings_update" on public.notification_settings
  for update using (auth.uid() = user_id);
create policy "notification_settings_delete" on public.notification_settings
  for delete using (auth.uid() = user_id);

create trigger notification_settings_updated_at
  before update on public.notification_settings
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 3. notification_log
-- =============================================================================
create table public.notification_log (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid references auth.users on delete cascade not null,
  notification_type   text not null
                        check (notification_type in ('tax_deadline', 'invoice_due', 'invoice_overdue')),
  reference_id        uuid not null,
  days_before         integer not null,
  sent_at             timestamptz default now(),
  delivery_status     text default 'sent'
                        check (delivery_status in ('sent', 'delivered', 'failed'))
);

alter table public.notification_log enable row level security;

create policy "notification_log_select" on public.notification_log
  for select using (auth.uid() = user_id);
create policy "notification_log_insert" on public.notification_log
  for insert with check (auth.uid() = user_id);
create policy "notification_log_update" on public.notification_log
  for update using (auth.uid() = user_id);
create policy "notification_log_delete" on public.notification_log
  for delete using (auth.uid() = user_id);

create index idx_notification_log_user_type_ref on public.notification_log (user_id, notification_type, reference_id);
