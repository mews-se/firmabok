-- Track initial-sync metadata per bank connection.
--
-- Decouples "have we ever done a backfill" (initial_sync_completed_at) from
-- "when did we last incrementally sync" (last_synced_at). The cron's first-sync
-- 90-day backfill path is gated on initial_sync_completed_at IS NULL, so the
-- "Sync now" button setting last_synced_at no longer permanently loses the
-- backfill window.
--
-- The returned-date columns power the UI's "we requested X but got Y" disclosure
-- when an ASPSP truncates history below the requested window.

ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS initial_sync_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_sync_requested_from date,
  ADD COLUMN IF NOT EXISTS initial_sync_returned_min_date date,
  ADD COLUMN IF NOT EXISTS initial_sync_returned_max_date date,
  ADD COLUMN IF NOT EXISTS initial_sync_lookback_days int;

NOTIFY pgrst, 'reload schema';
