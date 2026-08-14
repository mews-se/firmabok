-- Extension namespacing and API grants, following the upstream supabase
-- initial schema (see NOTICE). The app migrations create these extensions
-- with IF NOT EXISTS themselves; they are created here as well because
-- GoTrue migrates before the app migrations run.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- Unqualified uuid_generate_v4()/gen_random_bytes() in the migrations
-- resolve through the database-level search_path, as in the supabase image.
ALTER DATABASE postgres SET search_path TO "$user", public, extensions;
