-- Migration: claim_due_webhook_deliveries
--
-- Replaces the dispatcher's SELECT-then-UPDATE intersect pattern with a
-- single atomic SQL function using FOR UPDATE SKIP LOCKED. PostgREST cannot
-- express SKIP LOCKED through the JS client, so the previous shape (read
-- lib/webhooks/dispatcher.ts:232–292) did:
--
--   1. SELECT pending/failed rows ordered by next_attempt_at
--   2. UPDATE WHERE id IN (...) AND status IN ('pending','failed') -- CAS
--   3. Intersect (selected, returned-from-UPDATE) → claim set
--
-- That pattern is correct under concurrent ticks — the CAS guard ensures
-- only one tick wins per row — but burns two round trips per cycle and
-- doesn't communicate the locking semantics. Under load (slow receivers
-- stretching a tick past 60 s while the next minute's cron starts) both
-- ticks have to negotiate which rows they actually own.
--
-- The function form uses SKIP LOCKED inside a CTE, so a row already locked
-- by a concurrent tick is simply invisible to the second caller — no CAS
-- contention, one round trip. The dispatch loop becomes:
--
--   const { data } = await supabase.rpc('claim_due_webhook_deliveries', {
--     p_batch_size: 50, p_now: new Date().toISOString(),
--   })
--
-- All filter semantics from the existing JS path are preserved:
--   - status IN ('pending','failed')                (non-terminal, due-able)
--   - next_attempt_at <= p_now                       (genuinely due)
--   - webhook_id IS NOT NULL                         (dangling rows go dormant
--                                                     under the FK SET NULL
--                                                     from 20260515170000)
--   - ORDER BY next_attempt_at ASC                   (oldest-due-first)
--   - LIMIT p_batch_size                             (back-pressure)
--
-- The immutability trigger (enforce_webhook_delivery_immutability) is
-- already correct for this path: it RAISES when OLD.status is terminal
-- ('delivered', 'dead'); rows here have OLD.status in ('pending', 'failed')
-- so the UPDATE passes.
--
-- SECURITY DEFINER because the dispatcher runs under createServiceClient-
-- NoCookies (service-role), and a future change that hardens RLS or
-- restricts the service_role's UPDATE access on webhook_deliveries should
-- not silently break dispatch. The function is the documented entry point
-- for the dispatcher loop.

CREATE OR REPLACE FUNCTION public.claim_due_webhook_deliveries(
  p_batch_size int,
  p_now        timestamptz DEFAULT now()
)
RETURNS TABLE (
  id                  uuid,
  webhook_id          uuid,
  company_id          uuid,
  event_type          text,
  payload             jsonb,
  previous_attributes jsonb,
  api_version         text,
  attempts            int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Reject obviously-bad batch sizes early. A negative or zero batch size
  -- would degenerate the CTE into a no-op; a runaway value (e.g. an
  -- accidentally unbounded query) could lock too many rows in one tick
  -- and starve the next.
  IF p_batch_size IS NULL OR p_batch_size <= 0 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'p_batch_size must be in (0, 1000]; got %', p_batch_size
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT wd.id
    FROM public.webhook_deliveries wd
    WHERE wd.status IN ('pending', 'failed')
      AND wd.next_attempt_at <= p_now
      AND wd.webhook_id IS NOT NULL
    ORDER BY wd.next_attempt_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.webhook_deliveries wd
     SET status = 'in_flight'
    FROM due
   WHERE wd.id = due.id
  RETURNING wd.id,
            wd.webhook_id,
            wd.company_id,
            wd.event_type,
            wd.payload,
            wd.previous_attributes,
            wd.api_version,
            wd.attempts;
END;
$$;

NOTIFY pgrst, 'reload schema';
