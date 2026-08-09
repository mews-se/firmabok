-- Hardening pass on the ai-native-supp branch:
--   1. Adds a transient 'committing' status to pending_operations so the
--      commit dispatcher can claim a row atomically (CAS) before running
--      side-effects, eliminating the auto-commit / human-approval race.
--   2. Adds a DB trigger that prevents UPDATE on pending_operations rows
--      whose previous status was 'committed' or 'rejected' — required for
--      BFL 7 kap. (räkenskapsinformation must be unalterable post-commit).
--   3. Hardens idempotency_keys: company_id becomes NOT NULL, the unique
--      index includes company_id, and updated_at is added per CLAUDE.md
--      migration rule #2.
--   4. Replays the schema reload that 20260430120100 forgot.

-- =============================================================================
-- 1. pending_operations: add 'committing' transient status
-- =============================================================================
ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_status_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_status_check
  CHECK (status IN ('pending', 'committing', 'committed', 'rejected'));

-- =============================================================================
-- 2. pending_operations: immutability after commit/rejection
-- =============================================================================
-- Once a pending_op reaches a terminal state, the params/preview/result must
-- be unchangeable. The dispatcher writes resolved_at + result_data as part of
-- the same UPDATE that flips status, so we only need to block UPDATEs whose
-- OLD.status is already terminal.

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('committed', 'rejected') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be modified (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_operations_immutability ON public.pending_operations;
CREATE TRIGGER pending_operations_immutability
  BEFORE UPDATE ON public.pending_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_operations_immutability();

-- Block DELETE on terminal rows for the same reason.
CREATE OR REPLACE FUNCTION public.enforce_pending_operations_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('committed', 'rejected') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be deleted (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_operations_no_delete ON public.pending_operations;
CREATE TRIGGER pending_operations_no_delete
  BEFORE DELETE ON public.pending_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_operations_no_delete();

-- =============================================================================
-- 2b. pending_operations: input fields frozen at insert
-- =============================================================================
-- BFL 7 kap. requires the underlag (basis) for an affärshändelse to be
-- immutable, not just the result. The dispatcher only writes to status /
-- resolved_at / result_data after insert; params, operation_type, and
-- preview_data must never change once the row exists. Without this trigger,
-- a compromised path (or future code refactor) could rewrite the proposal
-- between staging and human approval.

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_input_frozen()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params THEN
    RAISE EXCEPTION
      'pending_operations.params is frozen after insert (BFL 7 kap. underlag-immutability)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.operation_type IS DISTINCT FROM OLD.operation_type THEN
    RAISE EXCEPTION
      'pending_operations.operation_type is frozen after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.preview_data IS DISTINCT FROM OLD.preview_data THEN
    RAISE EXCEPTION
      'pending_operations.preview_data is frozen after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_operations_input_frozen ON public.pending_operations;
CREATE TRIGGER pending_operations_input_frozen
  BEFORE UPDATE ON public.pending_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_operations_input_frozen();

-- =============================================================================
-- 3. idempotency_keys: company_id NOT NULL + scoped unique index + updated_at
-- =============================================================================
-- The previous migration left company_id nullable and the unique index keyed
-- on (user_id, key) only. For a user owning multiple companies, replaying the
-- same idempotency_key UUID across companies could return a cached response
-- from the wrong company. Scope the cache per (user, company, key) so the
-- replay can never cross tenant boundaries.

-- Defensive: any row created before this migration with a NULL company_id is
-- ambiguous and must be cleared rather than backfilled.
DELETE FROM public.idempotency_keys WHERE company_id IS NULL;

ALTER TABLE public.idempotency_keys
  ALTER COLUMN company_id SET NOT NULL;

DROP INDEX IF EXISTS idx_idempotency_keys_user_key;
CREATE UNIQUE INDEX idx_idempotency_keys_user_company_key
  ON public.idempotency_keys (user_id, company_id, key);

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS idempotency_keys_updated_at ON public.idempotency_keys;
CREATE TRIGGER idempotency_keys_updated_at
  BEFORE UPDATE ON public.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 4. PostgREST schema reload
-- =============================================================================
-- Also covers the ALTER on pending_operations from 20260430120100, which
-- forgot to issue this notification.
NOTIFY pgrst, 'reload schema';
