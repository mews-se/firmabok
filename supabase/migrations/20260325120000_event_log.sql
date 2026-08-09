-- Migration: Event Log
-- Append-only event log for external automation platform integration (n8n, Make, Zapier).
-- Events are ephemeral delivery records with 30-day TTL, NOT compliance audit logs.

-- =============================================================================
-- 1. event_log table
-- =============================================================================
CREATE TABLE public.event_log (
  sequence    BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  entity_id   UUID,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: append-only ephemeral delivery log
  -- No id UUID: sequence is the PK, cursor, and dedup key
);

-- Primary polling query: WHERE user_id = X AND sequence > cursor ORDER BY sequence
CREATE INDEX idx_event_log_user_seq ON public.event_log (user_id, sequence);

-- Retention cleanup: DELETE WHERE created_at < now() - interval '30 days'
CREATE INDEX idx_event_log_created_at ON public.event_log (created_at);

-- =============================================================================
-- 2. RLS
-- =============================================================================
ALTER TABLE public.event_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own events (browser polling)
CREATE POLICY "event_log_select" ON public.event_log
  FOR SELECT USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies: writes via service role client

-- =============================================================================
-- 3. Immutability (update only — deletes allowed for retention cleanup)
-- =============================================================================
CREATE TRIGGER event_log_no_update
  BEFORE UPDATE ON public.event_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();
