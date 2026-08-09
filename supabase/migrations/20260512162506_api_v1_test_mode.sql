-- =============================================================================
-- Phase 1: Public REST API v1 — test/live mode for API keys
-- =============================================================================
-- Adds `mode` to api_keys so a single user can own both `gnubok_sk_live_*` and
-- `gnubok_sk_test_*` keys. Test keys are intended to be bound to deterministic
-- sandbox companies in a later commit; this migration only adds the column and
-- surfaces it through the validate_and_increment_api_key RPC so the wrapper
-- can branch on it.
--
-- Existing rows are backfilled to 'live' to preserve current behaviour.
-- =============================================================================

-- 1. Column + check + index
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'live'
    CHECK (mode IN ('live', 'test'));

CREATE INDEX IF NOT EXISTS idx_api_keys_mode ON public.api_keys (mode);

-- 2. RPC: surface `mode` in the return type
-- (CREATE OR REPLACE cannot change return types in PostgreSQL — drop first.)
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text
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
  v_mode text;
BEGIN
  SELECT ak.user_id, ak.company_id, ak.id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode
  INTO v_user_id, v_company_id, v_api_key_id, v_api_key_name,
       v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode
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

    RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes, v_mode;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, true, v_scopes, v_mode;
    RETURN;
  END IF;

  UPDATE public.api_keys
  SET request_count = request_count + 1,
      last_used_at = now()
  WHERE key_hash = p_key_hash;

  RETURN QUERY SELECT v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes, v_mode;
END;
$$;

NOTIFY pgrst, 'reload schema';
