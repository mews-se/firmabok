-- Migration 033: AI Chat Schema
-- Creates tables for the AI chat assistant extension:
-- chat_sessions, chat_messages, knowledge_documents, and match_documents RPC

-- Enable pgvector for embedding storage
create extension if not exists vector with schema extensions;

-- ============================================================
-- chat_sessions
-- ============================================================

create table public.chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete cascade not null,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.chat_sessions enable row level security;

create policy "chat_sessions_select" on public.chat_sessions
  for select using (auth.uid() = user_id);
create policy "chat_sessions_insert" on public.chat_sessions
  for insert with check (auth.uid() = user_id);
create policy "chat_sessions_update" on public.chat_sessions
  for update using (auth.uid() = user_id);
create policy "chat_sessions_delete" on public.chat_sessions
  for delete using (auth.uid() = user_id);

create index idx_chat_sessions_user_created on public.chat_sessions (user_id, created_at desc);

create trigger chat_sessions_updated_at
  before update on public.chat_sessions
  for each row execute function public.update_updated_at_column();

-- ============================================================
-- chat_messages
-- ============================================================

create table public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references public.chat_sessions on delete cascade not null,
  user_id     uuid references auth.users on delete cascade not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  sources     jsonb,
  created_at  timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "chat_messages_select" on public.chat_messages
  for select using (auth.uid() = user_id);
create policy "chat_messages_insert" on public.chat_messages
  for insert with check (auth.uid() = user_id);
create policy "chat_messages_update" on public.chat_messages
  for update using (auth.uid() = user_id);
create policy "chat_messages_delete" on public.chat_messages
  for delete using (auth.uid() = user_id);

create index idx_chat_messages_session on public.chat_messages (session_id, created_at);

-- ============================================================
-- knowledge_documents
-- ============================================================

create table public.knowledge_documents (
  id             uuid primary key default gen_random_uuid(),
  source_file    text not null,
  title          text not null,
  section_title  text,
  content        text not null,
  content_hash   text unique not null,
  embedding      extensions.vector(1536),
  metadata       jsonb default '{}',
  created_at     timestamptz not null default now()
);

alter table public.knowledge_documents enable row level security;

-- Knowledge documents are shared — any authenticated user can read
create policy "knowledge_documents_select" on public.knowledge_documents
  for select using (true);

create index idx_knowledge_documents_hash on public.knowledge_documents (content_hash);

-- ============================================================
-- match_documents RPC (vector similarity search)
-- ============================================================

create or replace function public.match_documents(
  query_embedding extensions.vector,
  match_count int default 5,
  match_threshold float default 0.7
)
returns table (
  id uuid,
  source_file text,
  title text,
  section_title text,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select
    kd.id,
    kd.source_file,
    kd.title,
    kd.section_title,
    kd.content,
    kd.metadata,
    1 - (kd.embedding <=> query_embedding)::float as similarity
  from public.knowledge_documents kd
  where 1 - (kd.embedding <=> query_embedding) >= match_threshold
  order by kd.embedding <=> query_embedding
  limit match_count;
end;
$$;

grant execute on function public.match_documents(extensions.vector, int, float) to authenticated;
