-- Rotation grace + idempotent refresh for MCP OAuth (issue #710).
--
-- Problem: handleRefreshTokenGrant rotated BOTH the refresh token and the
-- access key in one CAS-guarded UPDATE with zero grace. A client (Claude Code
-- CLI) that fails to persist the rotated refresh token — or fires concurrent
-- refreshes — presents the just-superseded token, the CAS matches 0 rows, and
-- the grant dies with `invalid_grant`, forcing a full re-auth roughly every
-- ~60s in an endless loop.
--
-- Fix: keep rotation (RFC 9700 §4.14.2 requires public-client refresh tokens to
-- be rotated or sender-constrained) but add a bounded GRACE WINDOW with
-- idempotent replay:
--   * The just-superseded access key (`previous_key_hash`) and refresh token
--     (`previous_refresh_token_hash`) stay valid for a grace window.
--   * Presenting the previous refresh token WITHIN the window re-issues a fresh
--     pair (idempotent replay) and slides the window, so an actively-refreshing
--     client that cannot persist the rotated token is never stranded.
--   * Presenting it AFTER the window is a reuse/breach signal → the grant is
--     revoked (reuse detection preserved).
-- All four shadow columns default NULL → existing keys are unaffected. Because
-- the shadow columns live on the SAME row gated by `revoked_at IS NULL`, a
-- single `revoked_at` UPDATE atomically kills the current AND both previous
-- credentials (RFC 9700 grant-family revocation, no fan-out).

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS previous_key_hash            text,
  ADD COLUMN IF NOT EXISTS previous_key_expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS previous_refresh_token_hash  text,
  ADD COLUMN IF NOT EXISTS previous_refresh_expires_at  timestamptz;

-- Partial-UNIQUE on each previous hash: lookups are point reads and two rows can
-- never claim the same previous hash. Separate from the current-hash indexes so
-- current + previous coexist on one row without collision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_previous_key_hash
  ON public.api_keys (previous_key_hash)
  WHERE previous_key_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_previous_refresh_token_hash
  ON public.api_keys (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- validate_and_increment_api_key: accept the current key_hash OR an unexpired
-- previous_key_hash (access-token grace). Identical return shape, so callers in
-- lib/auth/api-keys.ts are unaffected. The rate-limit UPDATE is now keyed off
-- the resolved row id (not p_key_hash) so a grace-hash hit still increments.
-- (CREATE OR REPLACE cannot keep an identical signature across a body change
-- cleanly here; DROP+CREATE mirrors the pattern in 20260512162506.)
-- ---------------------------------------------------------------------------
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
  v_id uuid;
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- no live match (incl. expired grace) → caller returns 401, as before
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode;
END;
$$;

-- ---------------------------------------------------------------------------
-- rotate_mcp_refresh_token: atomic lookup + rotate + demote + idempotent replay
-- for the OAuth refresh_token grant. Replaces the JS SELECT-then-CAS (which had
-- a TOCTOU gap). The caller pre-generates the candidate new credentials; this
-- function decides whether to use them.
--
-- Outcomes:
--   'rotated'       presented hash = current refresh token → normal rotation;
--                   current creds demoted to previous_* with a grace window.
--   'replayed'      presented hash = an unexpired previous refresh token → the
--                   client retried / mis-persisted the rotated token (or a
--                   concurrent sibling already rotated). Re-issue a fresh pair
--                   and SLIDE the grace window so an actively-refreshing client
--                   keeps working. The previous hash is preserved (not chained)
--                   so a truly idle gap longer than the window still trips reuse.
--   'reuse_revoked' presented hash = an EXPIRED previous refresh token → reuse
--                   after grace = breach (RFC 9700 §4.14.2) → revoke the grant.
--   'revoked'       the matched grant is already revoked.
--   'invalid'       no matching grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotate_mcp_refresh_token(
  p_presented_hash    text,
  p_new_refresh_hash  text,
  p_new_key_hash      text,
  p_new_key_prefix    text,
  p_grace_seconds     integer
)
RETURNS TABLE(outcome text, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
  v_revoked timestamptz;
  v_scopes text[];
  v_cur_key_hash text;
  v_prev_refresh_expires timestamptz;
  v_match text;
BEGIN
  -- Current refresh token?
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash
  FROM public.api_keys ak
  WHERE ak.refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    v_match := 'current';
  ELSE
    -- Previous (just-rotated) refresh token?
    SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.previous_refresh_expires_at
      INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_prev_refresh_expires
    FROM public.api_keys ak
    WHERE ak.previous_refresh_token_hash = p_presented_hash
    FOR UPDATE;
    IF v_id IS NOT NULL THEN
      v_match := 'previous';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::text[];
    RETURN;
  END IF;

  IF v_revoked IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::text[];
    RETURN;
  END IF;

  IF v_match = 'current' THEN
    -- Normal rotation. Demote the consumed refresh token and the superseded
    -- access key to previous_* with a grace window, then promote the new pair.
    UPDATE public.api_keys
       SET previous_refresh_token_hash = p_presented_hash,
           previous_refresh_expires_at = now() + make_interval(secs => p_grace_seconds),
           previous_key_hash           = v_cur_key_hash,
           previous_key_expires_at     = now() + make_interval(secs => p_grace_seconds),
           refresh_token_hash          = p_new_refresh_hash,
           key_hash                    = p_new_key_hash,
           key_prefix                  = p_new_key_prefix
     WHERE id = v_id;
    RETURN QUERY SELECT 'rotated'::text, v_scopes;
    RETURN;
  END IF;

  -- v_match = 'previous'
  IF v_prev_refresh_expires IS NOT NULL AND v_prev_refresh_expires > now() THEN
    -- Idempotent in-grace replay: a retried / mis-persisted / concurrent
    -- refresh. Re-issue a fresh current pair and SLIDE the grace window. The
    -- previous refresh hash stays the presented one (no chaining), so reuse of
    -- the original token after an idle gap longer than the window still trips
    -- reuse detection below.
    UPDATE public.api_keys
       SET previous_refresh_expires_at = now() + make_interval(secs => p_grace_seconds),
           previous_key_hash           = v_cur_key_hash,
           previous_key_expires_at     = now() + make_interval(secs => p_grace_seconds),
           refresh_token_hash          = p_new_refresh_hash,
           key_hash                    = p_new_key_hash,
           key_prefix                  = p_new_key_prefix
     WHERE id = v_id;
    RETURN QUERY SELECT 'replayed'::text, v_scopes;
    RETURN;
  END IF;

  -- Reuse of a previous refresh token AFTER its grace window = breach signal.
  -- Revoke the grant family (single row → kills current + both previous creds).
  UPDATE public.api_keys
     SET revoked_at = now()
   WHERE id = v_id;
  RETURN QUERY SELECT 'reuse_revoked'::text, NULL::text[];
END;
$$;

NOTIFY pgrst, 'reload schema';
