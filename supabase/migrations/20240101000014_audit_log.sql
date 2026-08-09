-- Migration 14: Audit Log
-- Append-only audit log for all compliance-critical mutations

-- =============================================================================
-- 1. audit_log table
-- =============================================================================
CREATE TABLE public.audit_log (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL,  -- No FK cascade: survives user deletion
  action      text NOT NULL CHECK (action IN (
    'INSERT', 'UPDATE', 'DELETE',
    'COMMIT', 'REVERSE', 'CORRECT',
    'LOCK_PERIOD', 'CLOSE_PERIOD',
    'DOCUMENT_DELETE_BLOCKED', 'RETENTION_BLOCK',
    'SECURITY_EVENT'
  )),
  table_name  text,
  record_id   uuid,
  actor_id    uuid,
  old_state   jsonb,
  new_state   jsonb,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
  -- Intentionally NO updated_at: append-only
);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Users can only read their own audit log entries
CREATE POLICY "audit_log_select" ON public.audit_log
  FOR SELECT USING (auth.uid() = user_id);

-- No INSERT policy for normal users -- audit log is written by SECURITY DEFINER triggers
-- No UPDATE or DELETE policies -- immutability enforced by triggers below

CREATE INDEX idx_audit_log_user_id ON public.audit_log (user_id);
CREATE INDEX idx_audit_log_table_record ON public.audit_log (table_name, record_id);
CREATE INDEX idx_audit_log_action ON public.audit_log (action);
CREATE INDEX idx_audit_log_created_at ON public.audit_log (created_at);

-- =============================================================================
-- 2. Immutability triggers: block UPDATE and DELETE on audit_log
-- =============================================================================
CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries cannot be modified or deleted';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();
