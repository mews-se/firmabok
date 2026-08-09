-- Migration 038: Fix match_documents search_path
-- The function needs the extensions schema in search_path to use pgvector operators.

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
