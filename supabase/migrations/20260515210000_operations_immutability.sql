-- Migration: operations_immutability
--
-- BFNAR 2013:2 kap 8 § behandlingshistorik integrity: an audit row that
-- records the outcome of a system event becomes immutable once finalised.
-- For the v1 `operations` table the terminal states are `succeeded`,
-- `failed`, and `cancelled` — once any of those is set, the row records
-- what happened and must not be re-mutated. A future bug, a privileged
-- operator, or a compromised service-role caller cannot rewrite "this
-- year-end close succeeded" to "failed".
--
-- This mirrors the trigger pair the webhook_deliveries table got in
-- 20260515170000 (BEFORE UPDATE) + 20260515190000 (BEFORE DELETE). Same
-- predicate shape, same ERRCODE = check_violation, same SECURITY DEFINER
-- + search_path = public.
--
-- The lifecycle helpers (lib/api/v1/operations.ts) continue to legitimately
-- transition `running → succeeded/failed/cancelled` because OLD.status is
-- `running` (non-terminal) at the moment the UPDATE fires. Only post-
-- terminal mutations are blocked.
--
-- Carry-over from Phase 4 PR-2 (PR #469) review rounds: Swedish-compliance
-- flagged that the operations table allowed UPDATE/DELETE of result / error
-- / status on rows already in terminal status. Deferred at the time; closed
-- here as part of the Phase 6 PR-3 substrate-hardening pass.

-- ──────────────────────────────────────────────────────────────────────
-- 1. BEFORE UPDATE — block mutations to terminal-status rows
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_operation_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'operations row in terminal status (%) is immutable', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Name starts with 'e' so it fires before `operations_updated_at` (starts
-- with 'o') in default alphabetical trigger order. Belt-and-braces — the
-- RAISE would abort the entire UPDATE regardless, but firing first keeps
-- the failed-write trail tidy in pg_stat_user_tables.
CREATE TRIGGER enforce_operation_immutability
  BEFORE UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_operation_immutability();

-- ──────────────────────────────────────────────────────────────────────
-- 2. BEFORE DELETE — block hard-delete of terminal-status rows
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.block_operation_terminal_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION
      'operations row in terminal status (%) cannot be deleted (BFNAR 2013:2 kap 8 § behandlingshistorik integrity)',
      OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER block_operation_terminal_delete
  BEFORE DELETE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.block_operation_terminal_delete();

NOTIFY pgrst, 'reload schema';
