-- Drop and recreate validate_and_increment_api_key to add scopes to return type
-- (CREATE OR REPLACE cannot change return types in PostgreSQL)
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(user_id uuid, rate_limited boolean, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
BEGIN
  -- Lock row for atomic update
  SELECT ak.user_id, ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes
  INTO v_user_id, v_rate_limit_rpm, v_request_count, v_window_start, v_scopes
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

    RETURN QUERY SELECT v_user_id, false, v_scopes;
    RETURN;
  END IF;

  -- Check rate limit
  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, true, v_scopes;
    RETURN;
  END IF;

  -- Increment counter
  UPDATE public.api_keys
  SET request_count = request_count + 1,
      last_used_at = now()
  WHERE key_hash = p_key_hash;

  RETURN QUERY SELECT v_user_id, false, v_scopes;
END;
$$;
