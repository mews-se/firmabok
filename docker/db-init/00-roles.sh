#!/bin/sh
# API and service roles. Runs once at first boot via the official postgres
# image's /docker-entrypoint-initdb.d hook (before the .sql files, which
# sort after this name). CI runs the same script against its service
# container by exporting PGHOST/PGPASSWORD first.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v pgpass="$POSTGRES_PASSWORD" <<'EOSQL'
-- PostgREST's login role and the three JWT roles it switches into.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD :'pgpass';
GRANT anon, authenticated, service_role TO authenticator;

-- The API timeouts the app is calibrated against: several heavy RPCs
-- (SIE import/undo) carry their own SET statement_timeout to escape
-- these, and two pg tests assert that escape hatch.
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE authenticator SET statement_timeout = '8s';

-- GoTrue's role: owns the auth schema and runs its own migrations there.
CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE PASSWORD :'pgpass';
ALTER ROLE supabase_auth_admin SET search_path = 'auth';
EOSQL
