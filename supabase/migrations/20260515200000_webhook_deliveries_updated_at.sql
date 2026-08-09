-- Migration: webhook_deliveries_updated_at
--
-- Round-4 review on PR #496 — swedish-compliance bot caught that
-- `recoverStuckInFlight` in lib/webhooks/dispatcher.ts queries
-- `webhook_deliveries.updated_at` but the column was never declared.
-- Without an auto-stamped updated_at the in_flight recovery sweep
-- silently returns no rows and stuck deliveries stall forever,
-- breaking the BFNAR 2013:2 kap 8 § audit-log completeness guarantee
-- (every delivery row must reach a terminal state).
--
-- Fix:
--   1. Add the column with NOT NULL DEFAULT now() so existing rows get
--      a timestamp at backfill time.
--   2. Reuse the project-wide update_updated_at_column() trigger
--      function so every UPDATE auto-stamps the column.
--
-- The column lands AFTER the immutability triggers from migrations
-- 170000 and 190000, so an UPDATE on a terminal row still hits the
-- BEFORE UPDATE check_violation guard before the trigger has a chance
-- to bump updated_at — no audit-row mutation can occur.

ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE TRIGGER webhook_deliveries_updated_at
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
