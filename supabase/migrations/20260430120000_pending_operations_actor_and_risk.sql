-- Migration: Actor model + risk tier on pending_operations + audit_log
--
-- Adds first-class actor attribution (user vs api_key vs mcp_oauth vs cron) and
-- a risk_level for risk-tiered approval policies. This is the foundation for
-- letting trusted agents auto-commit low-risk proposals while keeping high-risk
-- operations (period close, year-end, send_invoice, etc.) gated behind human
-- approval regardless of trust level.
--
-- Why this lives here, not in app code:
--   - actor_type and risk_level are filtered/queried from the UI ("show me
--     only auto-committed actions")
--   - the same actor info needs to live in audit_log for compliance review
--   - having the columns enforced by check constraints prevents drift between
--     producers (MCP, OAuth, web, cron)

-- =============================================================================
-- 1. pending_operations: actor + risk columns
-- =============================================================================

ALTER TABLE public.pending_operations
  ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron'
  )),
  ADD COLUMN actor_id UUID,
  ADD COLUMN actor_label TEXT,
  ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'high' CHECK (risk_level IN (
    'low', 'medium', 'high'
  )),
  ADD COLUMN auto_commit_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN auto_committed_at TIMESTAMPTZ;

-- Index supporting the "auto-committed by Claude Desktop" filter tab on the
-- pending operations page.
CREATE INDEX idx_pending_ops_actor_type ON public.pending_operations (company_id, actor_type, status);
CREATE INDEX idx_pending_ops_auto_committed ON public.pending_operations (company_id, auto_committed_at)
  WHERE auto_committed_at IS NOT NULL;

-- Sanity: auto_committed_at can only be set when status = 'committed'.
ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_ops_auto_commit_status CHECK (
    auto_committed_at IS NULL OR status = 'committed'
  );

-- =============================================================================
-- 2. audit_log: mirror actor columns
-- =============================================================================
-- audit_log already has an `actor_id` column (uuid). We add actor_type/label
-- alongside so the UI can show "Auto-committed by Claude Desktop" without
-- needing a join through api_keys.

ALTER TABLE public.audit_log
  ADD COLUMN actor_type TEXT DEFAULT 'user' CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system'
  )),
  ADD COLUMN actor_label TEXT;

CREATE INDEX idx_audit_log_actor_type ON public.audit_log (user_id, actor_type, created_at DESC);

-- =============================================================================
-- 3. validate_and_increment_api_key: surface api_key_id + name for actor model
-- =============================================================================
-- The RPC previously returned only (user_id, company_id, rate_limited, scopes).
-- We now also return (api_key_id, api_key_name) so the MCP server can record
-- the actor on pending_operations / audit_log without an extra round-trip.

DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[]
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
BEGIN
  SELECT ak.user_id, ak.company_id, ak.id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes
  INTO v_user_id, v_company_id, v_api_key_id, v_api_key_name,
       v_rate_limit_rpm, v_request_count, v_window_start, v_scopes
  FROM public.api_keys ak
  WHERE ak.key_hash = p_key_hash AND ak.revoked_at IS NULL
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
    SET request_count = 1,
        rate_limit_window_start = now(),
        last_used_at = now()
    WHERE key_hash = p_key_hash;

    RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, true, v_scopes;
    RETURN;
  END IF;

  UPDATE public.api_keys
  SET request_count = request_count + 1,
      last_used_at = now()
  WHERE key_hash = p_key_hash;

  RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes;
END;
$$;

-- =============================================================================
-- 4. PostgREST schema reload
-- =============================================================================
NOTIFY pgrst, 'reload schema';
