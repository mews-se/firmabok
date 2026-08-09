-- Migration: webhook_deliveries_body_length_check
--
-- Defense-in-depth size cap on webhook_deliveries.response_body. The
-- application layer already truncates response bodies to 4 KB in
-- lib/webhooks/pinned-fetch.ts (the MAX_RESPONSE_BODY_BYTES constant
-- imported from the dispatcher). A future refactor that accidentally
-- bypasses that truncation — or a non-dispatcher write path that lands
-- in this column — would silently store large blobs in a column that
-- sits next to event payloads carrying personal data.
--
-- Adds a hard ceiling at the DB layer so any path that tries to write
-- a longer string is surfaced as a check_violation rather than persisted
-- (Art.32(1)(b) integrity of processing, A.8.24 protection of records).
-- The ceiling is set generously above the application limit so a
-- legitimate dispatcher write never hits this — only a regression would.

ALTER TABLE public.webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_response_body_length_check
  CHECK (response_body IS NULL OR length(response_body) <= 8192);

NOTIFY pgrst, 'reload schema';
