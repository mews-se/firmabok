#!/bin/sh
# Applies the app's SQL migrations in filename order, once each.
# Applied names are recorded in _firmabok.migrations, so re-running the
# service (which happens on every `docker compose up`) only applies new
# files. The SQL is not idempotent - this table is what makes updates
# safe.
set -eu

export PGHOST=db PGUSER=postgres PGDATABASE=postgres

tries=0
until pg_isready >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo 'database never became ready' >&2; exit 1; }
    sleep 2
done

psql -q -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists _firmabok;
create table if not exists _firmabok.migrations (
    name text primary key,
    applied_at timestamptz not null default now()
);
SQL

for f in /migrations/*.sql; do
    name=${f##*/}
    applied=$(psql -tA -v ON_ERROR_STOP=1 -c "select 1 from _firmabok.migrations where name = '$name'")
    if [ "$applied" = 1 ]; then
        continue
    fi
    echo "Applying $name"
    # one transaction for the file and its bookkeeping row, so a failure or an
    # interrupted run can never leave a migration applied but unrecorded
    psql -q -v ON_ERROR_STOP=1 -1 -f "$f" \
        -c "insert into _firmabok.migrations (name) values ('$name')"
done
echo 'Migrations up to date'
