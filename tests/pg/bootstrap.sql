-- pg-real CI bootstrap.
--
-- The Supabase Postgres image ships a partial `storage` schema; the remaining
-- columns and functions are provisioned at runtime by the storage-api
-- service, which we do not run in CI. This bootstrap aligns the schema with
-- what our migrations expect so the replay loop succeeds. It is idempotent
-- and safe to run against a freshly-initialised container.

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  owner       uuid,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE storage.buckets
  ADD COLUMN IF NOT EXISTS public              boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_size_limit     bigint,
  ADD COLUMN IF NOT EXISTS allowed_mime_types  text[];

CREATE TABLE IF NOT EXISTS storage.objects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id         text REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name              text,
  owner             uuid,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  last_accessed_at  timestamptz DEFAULT now(),
  metadata          jsonb,
  version           text,
  owner_id          text
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- storage.foldername(): splits a slash-delimited object name into segments.
-- Migrations use `(storage.foldername(name))[n]` to derive tenant scoping
-- from the object path.
CREATE OR REPLACE FUNCTION storage.foldername(name text)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT string_to_array(name, '/');
$$;
