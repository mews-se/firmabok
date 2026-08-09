-- Per-company minute + day counters for inbox ingestion (manual upload + email
-- inbound). Backstops against:
--   1) A logged-in user (or compromised session) flooding /upload.
--   2) An attacker who discovered a company's inbox address and mails in
--      hundreds of large attachments.
--
-- Atomic check-and-increment under INSERT…ON CONFLICT row locking — same
-- shape as validate_and_increment_api_key. No Upstash dependency.

CREATE TABLE IF NOT EXISTS public.inbox_rate_counters (
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  window_kind  text NOT NULL CHECK (window_kind IN ('minute','day')),
  window_key   text NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, window_kind, window_key)
);

ALTER TABLE public.inbox_rate_counters ENABLE ROW LEVEL SECURITY;
-- No user-facing policies — only SECURITY DEFINER fn writes this.

CREATE OR REPLACE FUNCTION public.check_and_increment_inbox_quota(
  p_company_id  uuid,
  p_minute_max  integer,
  p_day_max     integer
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
BEGIN
  -- 1) Minute window — slide upsert + increment, then check.
  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'minute', v_minute_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  -- 2) Day window — only checked when minute passed.
  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'day', v_day_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    -- Roll both counters back: the request didn't go through.
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'day'
        AND window_key = v_day_key;
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
