-- Harden check_and_increment_agent_quota against caller-chosen p_user_id.
--
-- The function is SECURITY DEFINER and lives in `public`, so PostgREST exposes
-- it at /rest/v1/rpc/check_and_increment_agent_quota with the default
-- EXECUTE-to-PUBLIC grant. p_user_id is a plain argument, and user ids are
-- discoverable through company_members, so any caller could burn down a
-- targeted user's minute/day budget and lock them out of every agent endpoint
-- for the rest of the day.
--
-- A plain REVOKE FROM PUBLIC alone is not the fix: all three callers (agent
-- invoke, onboarding stream, composer) call this with the user's own RLS
-- client, i.e. as `authenticated`, so revoking everything would break the
-- limiter and, because it fails open on error, silently remove the spend cap it
-- exists to enforce.
--
-- So: two layers.
--   1) Grants. Only `authenticated` and `service_role` may execute it at all.
--      `anon` is explicitly excluded: the anon key ships in the browser bundle,
--      so an unauthenticated caller could otherwise reach this RPC directly.
--   2) A caller guard in the body. An end-user role may only ever spend its own
--      quota. Roles that are not PostgREST end users (service_role, and the
--      migration/superuser role used by cron, jobs and tests) keep passing an
--      explicit user id, which they need in order to act on someone's behalf.
--
-- auth.uid() alone is NOT sufficient as the guard: it is NULL for `anon` as
-- well as for backend roles, so an unauthenticated caller would pass it.
--
-- Function body is otherwise byte-identical to 20260526140000.

CREATE OR REPLACE FUNCTION public.check_and_increment_agent_quota(
  p_user_id    uuid,
  p_minute_max integer,
  p_day_max    integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
  v_role         text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- Caller guard: anything arriving through PostgREST as an end user (anon or
  -- authenticated) may only spend the quota of the user it is authenticated as.
  IF v_role IN ('anon', 'authenticated') THEN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'check_and_increment_agent_quota: p_user_id must be the calling user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 1) Minute window — burst guard.
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'minute', v_minute_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  -- 2) Day window — slow-drip backstop (only checked once minute passes).
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'day', v_day_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    -- Roll both counters back: the request didn't go through.
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'day' AND window_key = v_day_key;
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Close the default PUBLIC grant and hand execute rights only to the roles that
-- legitimately call this: the three agent endpoints (as `authenticated`) and
-- backend/service contexts.
REVOKE ALL ON FUNCTION public.check_and_increment_agent_quota(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_and_increment_agent_quota(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_agent_quota(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_agent_quota(uuid, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
