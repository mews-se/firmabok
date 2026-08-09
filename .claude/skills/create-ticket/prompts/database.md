# Database Prompt

## Perspective

You are scanning for database schema, migration, and query issues in a Supabase PostgreSQL application with RLS. Focus on data integrity, performance, security policies, and compliance with Swedish accounting law (BFL 7-year retention, period locks, immutable posted entries).

## Checklist

### Schema Design
- [ ] Tables have UUID primary keys (`DEFAULT uuid_generate_v4()`)
- [ ] `user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL` on all user-owned tables
- [ ] `updated_at` trigger using `update_updated_at_column()` on all tables
- [ ] Appropriate NOT NULL constraints on required fields
- [ ] CHECK constraints for enum-like fields (status, type columns)
- [ ] Foreign keys with appropriate ON DELETE behavior (CASCADE vs RESTRICT)

### Row Level Security
- [ ] RLS enabled on every table
- [ ] SELECT policy: `auth.uid() = user_id`
- [ ] INSERT policy: `auth.uid() = user_id`
- [ ] UPDATE policy: `auth.uid() = user_id`
- [ ] No overly permissive policies (e.g., `true` for authenticated users)
- [ ] Service role access justified where used

### Indexes & Performance
- [ ] Indexes on foreign key columns used in JOINs
- [ ] Indexes on columns used in WHERE clauses (especially `user_id`, `status`, `date`)
- [ ] Composite indexes for common multi-column queries
- [ ] No missing indexes on large tables causing sequential scans
- [ ] No unnecessary indexes adding write overhead

### Migrations
- [ ] New migrations don't modify existing migration files
- [ ] Migrations are idempotent where possible (`IF NOT EXISTS`)
- [ ] Enforcement triggers (migration 017) never modified
- [ ] Timestamp-based naming for new migrations
- [ ] Backwards-compatible changes (additive, not destructive)

### Data Integrity
- [ ] Posted journal entries are immutable (enforced by trigger)
- [ ] Voucher numbers are sequential (assigned via DB RPC, never manually)
- [ ] Period lock enforcement prevents writes to closed periods
- [ ] 7-year document retention trigger prevents deletion
- [ ] Monetary values stored as numeric/decimal (not float)

### Queries (Application Layer)
- [ ] Queries filter by `user_id` as defense-in-depth alongside RLS
- [ ] No N+1 query patterns (batch fetches instead)
- [ ] `.select()` specifies columns (not `select('*')` on wide tables)
- [ ] Supabase `.single()` used when expecting one row
- [ ] Error handling on all database operations
- [ ] Transactions used for multi-step mutations

### Compliance
- [ ] Account numbers stored as strings (`'1930'`, not `1930`)
- [ ] Monetary calculations use `Math.round(x * 100) / 100` (not `toFixed()`)
- [ ] All journal entries route through the bookkeeping engine (never direct inserts)
- [ ] Storno pattern used for corrections (never edit posted entries)

## Classification

- **Bug**: Missing RLS policy, data integrity violation possible, missing NOT NULL allowing bad data, incorrect ON DELETE behavior, broken trigger.
- **Feature**: New table needs migration, new index for a new query pattern, new RPC function needed.
- **Improvement**: Missing index on existing table, overly broad SELECT, N+1 query could be batched, schema could use a CHECK constraint.
