-- Per-company toggle for the AI agent flow.
--
-- `ai_flow_enabled` is the master switch. When true:
--   * newly-classified receipts generate AI proposals (via orchestrator);
--   * the auto-book path in lib/transactions/ingest.ts is disabled — every
--     uncategorized transaction becomes a review item instead of being
--     silently posted at >=0.8 mapping-rule confidence;
--   * the /agent-inbox page becomes available.
--
-- `ai_backfill_cancel_requested` is the kill switch for in-flight backfill
-- loops. The backfill endpoint kicks off a fire-and-forget iteration over
-- pending receipts; each iteration checks this flag between items so the
-- loop can be stopped without a separate job queue.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS ai_flow_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.company_settings
  ALTER COLUMN ai_flow_enabled SET DEFAULT false;

UPDATE public.company_settings
  SET ai_flow_enabled = false
  WHERE ai_flow_enabled IS NULL;

ALTER TABLE public.company_settings
  ALTER COLUMN ai_flow_enabled SET NOT NULL;

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS ai_backfill_cancel_requested boolean NOT NULL DEFAULT false;

ALTER TABLE public.company_settings
  ALTER COLUMN ai_backfill_cancel_requested SET DEFAULT false;

UPDATE public.company_settings
  SET ai_backfill_cancel_requested = false
  WHERE ai_backfill_cancel_requested IS NULL;

ALTER TABLE public.company_settings
  ALTER COLUMN ai_backfill_cancel_requested SET NOT NULL;

NOTIFY pgrst, 'reload schema';
