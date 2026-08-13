-- Passwords for the service roles. supabase_functions_admin is absent on
-- purpose: it is created by the upstream webhooks init, which this stack
-- does not run (nothing uses pg_net). Naming it here would abort the whole
-- init sequence with "role does not exist", leaving the auth schema without
-- its ownership fixups and GoTrue unable to migrate.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
