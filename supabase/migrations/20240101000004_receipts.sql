-- Migration 4: Receipts
-- Receipt scanning with OCR extraction and transaction matching

-- =============================================================================
-- 1. receipts
-- =============================================================================
create table public.receipts (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid references auth.users on delete cascade not null,
  image_url               text not null,
  image_thumbnail_url     text,
  status                  text default 'pending' not null
                            check (status in ('pending', 'processing', 'extracted', 'confirmed', 'error')),
  extraction_confidence   numeric,
  merchant_name           text,
  merchant_org_number     text,
  merchant_vat_number     text,
  receipt_date            date,
  receipt_time            time,
  total_amount            numeric,
  currency                text default 'SEK',
  vat_amount              numeric,
  is_restaurant           boolean default false,
  is_systembolaget        boolean default false,
  is_foreign_merchant     boolean default false,
  representation_persons  integer,
  representation_purpose  text,
  matched_transaction_id  uuid references public.transactions (id) on delete set null,
  match_confidence        numeric,
  raw_extraction          jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.receipts enable row level security;

create policy "receipts_select" on public.receipts
  for select using (auth.uid() = user_id);
create policy "receipts_insert" on public.receipts
  for insert with check (auth.uid() = user_id);
create policy "receipts_update" on public.receipts
  for update using (auth.uid() = user_id);
create policy "receipts_delete" on public.receipts
  for delete using (auth.uid() = user_id);

create index idx_receipts_user_status on public.receipts (user_id, status);
create index idx_receipts_matched_transaction on public.receipts (matched_transaction_id);

create trigger receipts_updated_at
  before update on public.receipts
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 2. receipt_line_items
-- =============================================================================
create table public.receipt_line_items (
  id                      uuid primary key default uuid_generate_v4(),
  receipt_id              uuid references public.receipts (id) on delete cascade not null,
  description             text not null,
  quantity                numeric default 1,
  unit_price              numeric,
  line_total              numeric not null,
  vat_rate                numeric,
  vat_amount              numeric,
  is_business             boolean,
  category                text,
  bas_account             text,
  extraction_confidence   numeric,
  suggested_category      text,
  sort_order              integer default 0,
  created_at              timestamptz not null default now()
);

alter table public.receipt_line_items enable row level security;

create policy "receipt_line_items_select" on public.receipt_line_items
  for select using (
    exists (
      select 1 from public.receipts
      where receipts.id = receipt_line_items.receipt_id
        and receipts.user_id = auth.uid()
    )
  );
create policy "receipt_line_items_insert" on public.receipt_line_items
  for insert with check (
    exists (
      select 1 from public.receipts
      where receipts.id = receipt_line_items.receipt_id
        and receipts.user_id = auth.uid()
    )
  );
create policy "receipt_line_items_update" on public.receipt_line_items
  for update using (
    exists (
      select 1 from public.receipts
      where receipts.id = receipt_line_items.receipt_id
        and receipts.user_id = auth.uid()
    )
  );
create policy "receipt_line_items_delete" on public.receipt_line_items
  for delete using (
    exists (
      select 1 from public.receipts
      where receipts.id = receipt_line_items.receipt_id
        and receipts.user_id = auth.uid()
    )
  );

create index idx_receipt_line_items_receipt on public.receipt_line_items (receipt_id);

-- =============================================================================
-- Add FK from transactions.receipt_id -> receipts
-- =============================================================================
alter table public.transactions
  add constraint fk_transactions_receipt
  foreign key (receipt_id) references public.receipts (id) on delete set null;

create index idx_transactions_receipt_id on public.transactions (receipt_id);
