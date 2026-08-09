-- Extend notification_log's notification_type CHECK with
-- 'skv_connection_expired' (email nudge when the Skatteverket connection
-- dies and skattekonto sync is paused until the user reconnects with
-- BankID).
--
-- Background: SKV personal tokens live ~65 minutes. When one dies, the only
-- prior surface for the needs_reconsent state was the settings panel, which
-- users have no reason to revisit: prod has ~70 companies whose skattekonto
-- never synced because nothing told them to reconnect. The handler for
-- skattekonto.connection.expired (previously emitted but unconsumed) now
-- sends one email per consent episode.

ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_notification_type_check;

ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_notification_type_check
  CHECK (notification_type IN (
    'tax_deadline',
    'invoice_due',
    'invoice_overdue',
    'period_locked',
    'period_year_closed',
    'invoice_sent',
    'receipt_extracted',
    'receipt_matched',
    'missing_underlag',
    'skv_kvittens',
    'skv_connection_expired'
  )) NOT VALID;

ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_notification_type_check;

-- Atomic claim-then-send dedup, same mechanism as the kvittens index
-- (20260712113000): the handler inserts the log row FIRST and only sends
-- when the insert won; overlapping emitters (nightly cron vs manual sync)
-- get a 23505 and skip. Scoped per type: other notification types
-- legitimately log multiple rows per reference.
--
-- No defensive duplicate cleanup needed: the type is new in this migration,
-- so the CHECK above guarantees no existing rows can carry it.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Supabase branching applies
-- migrations inside a transaction, where CONCURRENTLY is not allowed.
-- notification_log is small and append-only; the brief lock is fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_skv_conn_expired_dedup
  ON public.notification_log (user_id, reference_id)
  WHERE notification_type = 'skv_connection_expired';

NOTIFY pgrst, 'reload schema';
