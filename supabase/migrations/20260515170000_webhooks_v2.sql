-- Migration: webhooks_v2
--
-- Phase 6 PR-1 substrate. Repurposes the legacy `automation_webhooks` table
-- (table existed from the early schema sync but was never wired to a delivery
-- pipeline) into the v1 `webhooks` registration table, and adds a new
-- `webhook_deliveries` queue + audit table that the per-minute dispatcher
-- cron consumes via FOR UPDATE SKIP LOCKED.
--
-- Design (per .claude/plans/research-analyze-and-create-tranquil-moon.md
-- §"Phase 6 — Webhook hardening + docs polish"):
--
--   webhooks: one row per (company, event_type, url). The legacy
--   UNIQUE (company_id, event_type) is dropped — multiple receivers per
--   event are valid (Stripe pattern). HMAC signing secret, api_version
--   pin (Stripe pattern), and disable bookkeeping live on this row.
--
--   webhook_deliveries: one row per outbound POST attempt batch (the
--   same row carries `attempts` across retries; a fresh row per retry
--   would inflate storage 7x). State machine:
--     pending  → in_flight → delivered  (success)
--                          → failed     (will retry — bumps attempts +
--                                        next_attempt_at)
--                          → dead       (terminal, attempts exhausted
--                                        OR receiver returned 410)
--
-- Retry policy (enforced in lib/webhooks/dispatcher.ts):
--   1m, 5m, 30m, 2h, 12h, 24h, 48h — 7 attempts, ~72h total, exponential.
--   HTTP 410 from receiver → auto-disable webhook + mark delivery `dead`.
--
-- Audit immutability: terminal-status delivery rows (delivered, dead) are
-- write-locked by trigger. The legal basis varies by event type:
--
--   - For accounting-event deliveries (journal_entry.committed,
--     journal_entry.reversed, journal_entry.corrected, period.locked,
--     period.year_closed, salary_run.booked, agi.generated, invoice.paid,
--     supplier_invoice.paid): immutability is required by BFL 7 kap 1 §
--     (räkenskapsinformation retention, 7 years after the calendar year
--     the räkenskapsår ended) AND BFNAR 2013:2 kap 8 § (behandlingshistorik
--     integrity).
--
--   - For non-accounting deliveries (customer.created, document.uploaded,
--     transaction.categorized, webhook.test): immutability is required by
--     gnubok's operational audit-log integrity policy. BFL/BFNAR do NOT
--     apply to these rows — the trigger applies the same lock as a
--     uniform audit-trail policy, not as a statutory obligation.
--
-- The trigger does not differentiate by event type because per-row
-- runtime classification adds no defensive value (the operational policy
-- is the strict superset). Same pattern lives on `audit_log` and is
-- queued for `operations` (Phase 5 carry-over).

-- ──────────────────────────────────────────────────────────────────────
-- 1. webhooks — drop legacy unique, add new columns
-- ──────────────────────────────────────────────────────────────────────

-- The legacy table guards rename with a safe IF EXISTS path so this
-- migration is idempotent in dev/test environments where webhooks_v2 may
-- have been applied + reverted manually.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'automation_webhooks')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'webhooks') THEN
    ALTER TABLE public.automation_webhooks RENAME TO webhooks;
  END IF;
END $$;

-- Drop the one-event-per-company-per-row UNIQUE — the v1 contract allows
-- multiple receivers to subscribe to the same event_type (different
-- environments, fan-out to multiple downstream services).
ALTER TABLE public.webhooks
  DROP CONSTRAINT IF EXISTS automation_webhooks_company_id_event_type_key;

-- Index on the legacy active-only filter — we keep it but rename the
-- index so future inspections show the post-rename name.
DROP INDEX IF EXISTS public.idx_automation_webhooks_company_event;

ALTER TABLE public.webhooks
  ADD COLUMN IF NOT EXISTS name                  text NOT NULL DEFAULT 'webhook',
  ADD COLUMN IF NOT EXISTS description           text,
  ADD COLUMN IF NOT EXISTS secret                text,
  ADD COLUMN IF NOT EXISTS created_by_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS api_version_pinned    text NOT NULL DEFAULT '2026-05-12',
  ADD COLUMN IF NOT EXISTS disabled_at           timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason       text;

-- secret defaults NULL on existing rows (none in production) but is
-- mandatory for new rows. The route generates the secret server-side on
-- POST and returns it once; we cannot generate via DEFAULT because the
-- raw value must be returned in the response and never re-readable.
-- Backfill placeholder so the NOT NULL constraint can be added without
-- breaking dev-environment rows.
UPDATE public.webhooks SET secret = encode(gen_random_bytes(32), 'hex')
  WHERE secret IS NULL;

ALTER TABLE public.webhooks
  ALTER COLUMN secret SET NOT NULL;

-- Replacement index — supports the dispatcher's per-event lookup.
CREATE INDEX IF NOT EXISTS idx_webhooks_company_event_active
  ON public.webhooks (company_id, event_type)
  WHERE disabled_at IS NULL AND active = true;

-- ──────────────────────────────────────────────────────────────────────
-- 2. webhook_deliveries — outbound delivery queue + audit
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. company_id is denormalised onto the delivery row (also
  -- recoverable via webhook_id → webhooks.company_id) so RLS + the
  -- worker query don't have to join.
  --
  -- webhook_id is nullable + ON DELETE SET NULL so a webhook DELETE
  -- preserves the delivery audit trail (BFL 7 kap 1 § retention +
  -- BFNAR 2013:2 kap 8 § behandlingshistorik integrity for accounting
  -- events: journal_entry.committed, period.locked, salary_run.booked,
  -- agi.generated, ...). The dispatcher filters webhook_id IS NOT NULL
  -- so dangling rows go dormant in the audit trail rather than retrying
  -- against nothing.
  webhook_id          uuid REFERENCES public.webhooks(id) ON DELETE SET NULL,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Payload identity
  event_type          text NOT NULL,
  payload             jsonb NOT NULL,
  previous_attributes jsonb,
  api_version         text NOT NULL,

  -- Lifecycle
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_flight', 'delivered', 'failed', 'dead')),
  attempts            int  NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),

  -- Last response capture (overwritten per attempt; full per-attempt
  -- forensic log is out of scope for v1 — open a new row only if the
  -- caller hits :retry on a `dead` row).
  response_status     int,
  response_body       text,
  response_headers    jsonb,
  error               text,

  -- Audit
  request_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz
);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Members of the company can read their company's deliveries.
-- All writes go through the service-role dispatcher / route handlers; no
-- anon/authenticated INSERT/UPDATE/DELETE policy.
CREATE POLICY "webhook_deliveries_select"
  ON public.webhook_deliveries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- Worker pickup: oldest due deliveries with status pending or failed.
-- (failed = scheduled for retry; in_flight = currently being attempted by
-- a worker, do not re-pick. The worker uses FOR UPDATE SKIP LOCKED so the
-- partial WHERE narrows the candidate set.)
CREATE INDEX idx_webhook_deliveries_due
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Per-webhook listing: GET /webhooks/{id}/deliveries.
CREATE INDEX idx_webhook_deliveries_webhook_created
  ON public.webhook_deliveries (webhook_id, created_at DESC);

-- Per-company listing (future surface).
CREATE INDEX idx_webhook_deliveries_company_created
  ON public.webhook_deliveries (company_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────
-- 3. Immutability trigger — terminal-status delivery rows are write-locked
-- ──────────────────────────────────────────────────────────────────────
--
-- BFL 7 kap 1 § (retention, accounting-event rows) + BFNAR 2013:2 kap 8 §
-- (behandlingshistorik integrity, all rows): an audit row that records the
-- outcome of a system event becomes immutable once finalised. For
-- webhook deliveries the terminal states are `delivered` and `dead`.
-- `failed` is NOT terminal (the dispatcher will mutate it back to
-- `in_flight` and then to one of the terminal states or back to
-- `failed` with bumped attempts).
--
-- The :retry route bypasses the trigger by going through a service-role
-- function that re-opens the row by INSERT-ing a fresh delivery row
-- pointing at the same payload, NOT by mutating the terminal row in place.

CREATE OR REPLACE FUNCTION public.enforce_webhook_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('delivered', 'dead') THEN
    RAISE EXCEPTION 'webhook_deliveries row in terminal status (%) is immutable', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_webhook_delivery_immutability
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_webhook_delivery_immutability();

-- ──────────────────────────────────────────────────────────────────────
-- 4. updated_at trigger on webhooks (table predates updated_at trigger;
--    the legacy migration installed `set_updated_at` already — leave it
--    in place).
-- ──────────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
