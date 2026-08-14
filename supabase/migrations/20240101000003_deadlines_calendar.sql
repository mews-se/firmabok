-- Migration 3: Deadlines
-- Deadline tracking

-- =============================================================================
-- 1. deadlines
-- =============================================================================
create table public.deadlines (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references auth.users on delete cascade not null,
  title                 text not null,
  due_date              date not null,
  due_time              time,
  deadline_type         text default 'other'
                          check (deadline_type in ('delivery', 'invoicing', 'report', 'tax', 'other')),
  priority              text default 'normal'
                          check (priority in ('critical', 'important', 'normal')),
  is_completed          boolean default false,
  completed_at          timestamptz,
  customer_id           uuid references public.customers (id) on delete set null,
  is_auto_generated     boolean default false,
  notes                 text,
  tax_deadline_type     text,
  tax_period            text,
  source                text default 'user'
                          check (source in ('system', 'user')),
  reminder_offsets      integer[] default '{14,7,1,0}',
  status                text default 'upcoming'
                          check (status in ('upcoming', 'action_needed', 'in_progress', 'submitted', 'confirmed', 'overdue')),
  status_changed_at     timestamptz default now(),
  linked_report_type    text,
  linked_report_period  jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.deadlines enable row level security;

create policy "deadlines_select" on public.deadlines
  for select using (auth.uid() = user_id);
create policy "deadlines_insert" on public.deadlines
  for insert with check (auth.uid() = user_id);
create policy "deadlines_update" on public.deadlines
  for update using (auth.uid() = user_id);
create policy "deadlines_delete" on public.deadlines
  for delete using (auth.uid() = user_id);

create index idx_deadlines_user_id on public.deadlines (user_id);
create index idx_deadlines_due_date on public.deadlines (due_date);
create index idx_deadlines_deadline_type on public.deadlines (deadline_type);
create index idx_deadlines_user_completed on public.deadlines (user_id, is_completed);

create trigger deadlines_updated_at
  before update on public.deadlines
  for each row execute function public.update_updated_at_column();
