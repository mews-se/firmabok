-- API keys for external integrations (MCP, webhooks, future public API)
CREATE TABLE public.api_keys (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash        text NOT NULL,
  key_prefix      text NOT NULL,          -- e.g. "gnubok_sk_a8f2..." for display
  name            text NOT NULL DEFAULT 'Unnamed key',
  scopes          text[] DEFAULT NULL,     -- NULL = full access. Future: ['read', 'write', 'mcp']
  rate_limit_rpm  integer NOT NULL DEFAULT 100,
  request_count   integer NOT NULL DEFAULT 0,
  rate_limit_window_start timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own api_keys"
  ON public.api_keys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own api_keys"
  ON public.api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own api_keys"
  ON public.api_keys FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own api_keys"
  ON public.api_keys FOR DELETE USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_api_keys_user_id ON public.api_keys (user_id);
CREATE UNIQUE INDEX idx_api_keys_key_hash ON public.api_keys (key_hash);

-- Triggers
CREATE TRIGGER set_updated_at_api_keys
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_api_keys
  AFTER INSERT OR UPDATE OR DELETE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Atomic rate-limited key validation (called by service role, bypasses RLS)
CREATE OR REPLACE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(user_id uuid, rate_limited boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
BEGIN
  -- Lock row for atomic update
  SELECT ak.user_id, ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start
  INTO v_user_id, v_rate_limit_rpm, v_request_count, v_window_start
  FROM public.api_keys ak
  WHERE ak.key_hash = p_key_hash AND ak.revoked_at IS NULL
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Reset window if expired (> 1 minute old)
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
    SET request_count = 1,
        rate_limit_window_start = now(),
        last_used_at = now()
    WHERE key_hash = p_key_hash;

    RETURN QUERY SELECT v_user_id, false;
    RETURN;
  END IF;

  -- Check rate limit
  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, true;
    RETURN;
  END IF;

  -- Increment counter
  UPDATE public.api_keys
  SET request_count = request_count + 1,
      last_used_at = now()
  WHERE key_hash = p_key_hash;

  RETURN QUERY SELECT v_user_id, false;
END;
$$;
