-- Migration: webhook_deliveries_retention
--
-- Originally added in PR #496 round 1 to ALTER the webhook_deliveries.webhook_id
-- FK from ON DELETE CASCADE to ON DELETE SET NULL (BFNAR 2013:2 kap 8 §
-- behandlingshistorik + BFL 7 kap retention).
--
-- In round 3 the FK declaration was folded directly into migration
-- 20260515170000 (clean schema state for fresh installs). This file is
-- retained for migration-history continuity — Supabase preview branches
-- track the set of applied remote migrations and fail reconciliation if
-- a previously-applied filename disappears locally.
--
-- The body below is fully idempotent:
--   - On a fresh install: 170000 creates the FK with SET NULL; this
--     migration's ALTER is a no-op (DROP IF EXISTS + ADD with the same
--     constraint shape).
--   - On a preview branch that applied the original 170000 (CASCADE) +
--     this 180000 (the original ALTER): the column is already nullable
--     and the FK is already SET NULL; ALTER is a no-op.
--   - Idempotent retro-application is intentional so neither path
--     diverges from the canonical post-migration schema state.

ALTER TABLE public.webhook_deliveries
  ALTER COLUMN webhook_id DROP NOT NULL;

ALTER TABLE public.webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_webhook_id_fkey;

ALTER TABLE public.webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_webhook_id_fkey
    FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
