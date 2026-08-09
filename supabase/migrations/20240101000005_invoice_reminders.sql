-- Migration 5: Invoice Reminders
-- Automated reminder tracking with self-service action tokens

-- =============================================================================
-- invoice_reminders
-- =============================================================================
create table public.invoice_reminders (
  id                uuid primary key default uuid_generate_v4(),
  invoice_id        uuid references public.invoices (id) on delete cascade not null,
  user_id           uuid references auth.users on delete cascade not null,
  reminder_level    integer not null check (reminder_level in (1, 2, 3)),
  sent_at           timestamptz default now(),
  email_to          text not null,
  response_type     text check (response_type in ('marked_paid', 'disputed')),
  response_at       timestamptz,
  action_token      text unique not null default encode(gen_random_bytes(32), 'hex'),
  action_token_used boolean default false,
  created_at        timestamptz not null default now()
);

alter table public.invoice_reminders enable row level security;

create policy "invoice_reminders_select" on public.invoice_reminders
  for select using (auth.uid() = user_id);
create policy "invoice_reminders_insert" on public.invoice_reminders
  for insert with check (auth.uid() = user_id);
create policy "invoice_reminders_update" on public.invoice_reminders
  for update using (auth.uid() = user_id);
create policy "invoice_reminders_delete" on public.invoice_reminders
  for delete using (auth.uid() = user_id);

create index idx_invoice_reminders_action_token on public.invoice_reminders (action_token);
create index idx_invoice_reminders_invoice on public.invoice_reminders (invoice_id);
