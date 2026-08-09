-- Migration 18: Audit Logging Triggers
-- Generic audit log writer with AFTER triggers on compliance-critical tables

-- =============================================================================
-- 1. Generic write_audit_log() SECURITY DEFINER function
-- Detects action type from TG_OP and state transitions
-- =============================================================================
CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id   uuid;
  v_action    text;
  v_old_state jsonb;
  v_new_state jsonb;
  v_record_id uuid;
  v_desc      text;
BEGIN
  -- Determine user_id from the record
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_record_id := OLD.id;
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_user_id := NEW.user_id;
    v_record_id := NEW.id;
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_user_id := COALESCE(NEW.user_id, OLD.user_id);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    -- Detect specific state transitions for journal_entries
    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    -- Detect period lock/close
    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- Write to audit log (bypass RLS via SECURITY DEFINER)
  INSERT INTO public.audit_log (user_id, action, table_name, record_id, actor_id, old_state, new_state, description)
  VALUES (v_user_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc);

  -- Return appropriate value
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. AFTER triggers on compliance-critical tables
-- =============================================================================

-- journal_entries
CREATE TRIGGER audit_journal_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- journal_entry_lines
CREATE TRIGGER audit_journal_entry_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- chart_of_accounts
CREATE TRIGGER audit_chart_of_accounts
  AFTER INSERT OR UPDATE OR DELETE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- document_attachments
CREATE TRIGGER audit_document_attachments
  AFTER INSERT OR UPDATE OR DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- fiscal_periods
CREATE TRIGGER audit_fiscal_periods
  AFTER INSERT OR UPDATE OR DELETE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- company_settings
CREATE TRIGGER audit_company_settings
  AFTER INSERT OR UPDATE OR DELETE ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- tax_codes trigger removed: table never created (migration 012 is a placeholder)
