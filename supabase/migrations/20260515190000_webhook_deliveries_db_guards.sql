-- Migration: webhook_deliveries_db_guards
--
-- Round-2 review on PR #496. Two DB-level invariants the application can
-- never bypass: (1) audit-log integrity policy (all rows) + BFL 7 kap 1 §
-- retention (accounting-event rows specifically) extend to DELETE on
-- terminal rows; (2) webhook_deliveries.company_id MUST match its parent
-- webhooks.company_id at INSERT time.
--
-- Both are belt-and-braces alongside existing application-layer guards:
--   - Migration 20260515170000 declares the webhook_id FK with
--     ON DELETE SET NULL so a webhook DELETE preserves the delivery
--     audit trail. But a privileged operator (or a future bug) could
--     still issue a direct DELETE on a delivery row. The new
--     BEFORE DELETE trigger forecloses that path for terminal rows.
--   - The dispatcher's loadWebhooksByIds + cross-tenant assertion already
--     blocks dispatch when company_id mismatches at the application layer.
--     The new BEFORE INSERT trigger blocks the mismatch from being
--     written in the first place — closes the window where a compromised
--     service-role caller could enqueue a delivery against another
--     tenant's webhook.

-- ──────────────────────────────────────────────────────────────────────
-- 1. BEFORE DELETE — block hard-delete of terminal-status rows
-- ──────────────────────────────────────────────────────────────────────
--
-- The 20260515170000 migration installed an enforce_webhook_delivery_immutability
-- trigger BEFORE UPDATE only. Direct DELETE bypassed it. Adding a
-- BEFORE DELETE counterpart for the same predicate.
--
-- Note: the function from migration 170000 is reused for the UPDATE path
-- (single source of truth for the terminal-row predicate). We define a
-- thin DELETE-specific function here that calls the same predicate.

CREATE OR REPLACE FUNCTION public.block_webhook_delivery_terminal_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('delivered', 'dead') THEN
    RAISE EXCEPTION
      'webhook_deliveries row in terminal status (%) cannot be deleted (audit-log integrity policy; accounting-event rows additionally fall under BFL 7 kap 1 § retention)',
      OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER block_webhook_delivery_terminal_delete
  BEFORE DELETE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.block_webhook_delivery_terminal_delete();

-- ──────────────────────────────────────────────────────────────────────
-- 2. BEFORE INSERT — assert delivery.company_id == parent webhook.company_id
-- ──────────────────────────────────────────────────────────────────────
--
-- A delivery row whose company_id doesn't match its parent webhook's is
-- structurally invalid: it would either (a) display under the wrong
-- tenant's GET /webhooks/{id}/deliveries call, (b) cause the dispatcher
-- to sign with the wrong tenant's secret, or (c) leak existence of one
-- tenant's webhook to another.
--
-- The dispatcher's application-layer cross-tenant assertion catches case
-- (b); this trigger forecloses cases (a) and (c) at write time.
--
-- webhook_id IS NULL bypasses the check — those are dangling rows from
-- webhook DELETE under the round-1 ON DELETE SET NULL FK and have no
-- parent to compare against; the trigger leaves them alone.

CREATE OR REPLACE FUNCTION public.assert_webhook_delivery_company_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_company_id uuid;
BEGIN
  IF NEW.webhook_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT company_id INTO parent_company_id
    FROM public.webhooks
    WHERE id = NEW.webhook_id;

  IF parent_company_id IS NULL THEN
    -- The webhook row doesn't exist. Either the FK will fail (if it's
    -- a real bad reference) or this is a race; let the FK constraint
    -- surface the error rather than masking it here.
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM parent_company_id THEN
    RAISE EXCEPTION
      'webhook_deliveries.company_id (%) does not match parent webhooks.company_id (%) for webhook_id %',
      NEW.company_id, parent_company_id, NEW.webhook_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER assert_webhook_delivery_company_match
  BEFORE INSERT ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.assert_webhook_delivery_company_match();

NOTIFY pgrst, 'reload schema';
