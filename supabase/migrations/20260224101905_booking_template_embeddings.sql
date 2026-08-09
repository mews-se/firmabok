-- Migration 040: Booking Template Embeddings
-- Stores pre-computed embeddings for booking templates to enable
-- semantic similarity search for transaction classification.

-- ============================================================
-- booking_template_embeddings
-- ============================================================

create table public.booking_template_embeddings (
  id              uuid primary key default gen_random_uuid(),
  template_id     text unique not null,
  embedding       extensions.vector(1536) not null,
  embedding_text  text not null,
  model           text not null,
  schema_version  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.booking_template_embeddings enable row level security;

-- Shared system data — any authenticated user can read
create policy "booking_template_embeddings_select" on public.booking_template_embeddings
  for select using (true);

-- Only service role can insert/update (no user-scoped writes)
-- RLS blocks regular users from writing; service role bypasses RLS

create trigger booking_template_embeddings_updated_at
  before update on public.booking_template_embeddings
  for each row execute function public.update_updated_at_column();

-- HNSW index for fast cosine similarity search
create index idx_booking_template_embeddings_embedding
  on public.booking_template_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

create index idx_booking_template_embeddings_template_id
  on public.booking_template_embeddings (template_id);

-- ============================================================
-- match_booking_templates RPC (vector similarity search)
-- ============================================================

create or replace function public.match_booking_templates(
  query_embedding extensions.vector,
  match_count int default 20,
  match_threshold float default 0.5
)
returns table (
  template_id text,
  embedding_text text,
  similarity float
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select
    bte.template_id,
    bte.embedding_text,
    1 - (bte.embedding <=> query_embedding)::float as similarity
  from public.booking_template_embeddings bte
  where 1 - (bte.embedding <=> query_embedding) >= match_threshold
  order by bte.embedding <=> query_embedding
  limit match_count;
end;
$$;

grant execute on function public.match_booking_templates(extensions.vector, int, float) to authenticated;
