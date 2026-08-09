-- Migration 17: Enforcement Triggers
-- Critical compliance triggers for Bokföringslagen

-- =============================================================================
-- 1. enforce_journal_entry_immutability()
-- BEFORE UPDATE/DELETE on journal_entries
-- Allows: draft→draft edits, draft→posted commit, posted→reversed transition
-- Blocks: all other updates/deletes on posted/reversed entries
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allow deleting drafts
    IF OLD.status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete a % journal entry (id: %)', OLD.status, OLD.id;
  END IF;

  -- TG_OP = 'UPDATE'
  -- Allow: draft → draft (editing a draft)
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Allow: draft → posted (committing)
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    RETURN NEW;
  END IF;

  -- Allow: posted → reversed (storno reversal)
  IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
    -- Only allow setting reversed_by_id during this transition
    IF NEW.description != OLD.description
       OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Block all other transitions
  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokföringslagen.',
    OLD.status, OLD.id;
END;
$$;

CREATE TRIGGER enforce_journal_entry_immutability
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_immutability();

-- =============================================================================
-- 2. enforce_journal_entry_line_immutability()
-- BEFORE UPDATE/DELETE on journal_entry_lines
-- Blocks modifications to lines of posted/reversed entries
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  -- Get the parent entry status
  SELECT status INTO v_status
  FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Allow modifications to lines of draft entries
  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Block modifications to lines of posted/reversed entries
  RAISE EXCEPTION 'Cannot % lines of a % journal entry. Committed entries are immutable per Bokföringslagen.',
    TG_OP, v_status;
END;
$$;

CREATE TRIGGER enforce_journal_entry_line_immutability
  BEFORE UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_line_immutability();

-- =============================================================================
-- 3. enforce_period_lock()
-- BEFORE INSERT/UPDATE on journal_entries
-- Rejects writes when fiscal_periods.is_closed=true OR locked_at IS NOT NULL
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_period_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_closed boolean;
  v_locked_at timestamptz;
  v_period_name text;
BEGIN
  SELECT is_closed, locked_at, name
  INTO v_is_closed, v_locked_at, v_period_name
  FROM public.fiscal_periods
  WHERE id = NEW.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot write to locked/closed fiscal period "%" (is_closed=%, locked_at=%)',
      v_period_name, v_is_closed, v_locked_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_period_lock
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock();

-- =============================================================================
-- 4. enforce_period_lock_documents()
-- BEFORE INSERT/UPDATE on document_attachments
-- Blocks doc attachment to entries in locked periods
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_period_lock_documents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_closed boolean;
  v_locked_at timestamptz;
BEGIN
  -- Only check if linking to a journal entry
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT fp.is_closed, fp.locked_at
  INTO v_is_closed, v_locked_at
  FROM public.journal_entries je
  JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
  WHERE je.id = NEW.journal_entry_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot attach documents to entries in a locked/closed fiscal period';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_period_lock_documents
  BEFORE INSERT OR UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock_documents();

-- =============================================================================
-- 5. block_document_deletion()
-- BEFORE DELETE on document_attachments
-- Blocks deletion if linked to committed entry or within retention window
-- =============================================================================
CREATE OR REPLACE FUNCTION public.block_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_entry_status text;
  v_retention_expires date;
BEGIN
  -- Check if linked to a committed journal entry
  IF OLD.journal_entry_id IS NOT NULL THEN
    SELECT je.status INTO v_entry_status
    FROM public.journal_entries je
    WHERE je.id = OLD.journal_entry_id;

    IF v_entry_status IN ('posted', 'reversed') THEN
      -- Log the blocked attempt
      INSERT INTO public.audit_log (user_id, action, table_name, record_id, description)
      VALUES (OLD.user_id, 'DOCUMENT_DELETE_BLOCKED', 'document_attachments', OLD.id,
        'Attempted deletion of document linked to ' || v_entry_status || ' journal entry ' || OLD.journal_entry_id);

      RAISE EXCEPTION 'Cannot delete document linked to a % journal entry (Bokföringslagen)',
        v_entry_status;
    END IF;
  END IF;

  -- Check retention window
  IF OLD.journal_entry_id IS NOT NULL THEN
    SELECT fp.retention_expires_at INTO v_retention_expires
    FROM public.journal_entries je
    JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE je.id = OLD.journal_entry_id;

    IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
      INSERT INTO public.audit_log (user_id, action, table_name, record_id, description)
      VALUES (OLD.user_id, 'RETENTION_BLOCK', 'document_attachments', OLD.id,
        'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

      RAISE EXCEPTION 'Cannot delete document within 7-year retention period (expires %)',
        v_retention_expires;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER block_document_deletion
  BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.block_document_deletion();

-- =============================================================================
-- 6. enforce_retention_journal_entries()
-- BEFORE DELETE on journal_entries
-- Blocks deletion within 7-year retention window
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_retention_expires date;
BEGIN
  SELECT fp.retention_expires_at INTO v_retention_expires
  FROM public.fiscal_periods fp
  WHERE fp.id = OLD.fiscal_period_id;

  IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
    INSERT INTO public.audit_log (user_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, 'RETENTION_BLOCK', 'journal_entries', OLD.id,
      'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

    RAISE EXCEPTION 'Cannot delete journal entry within 7-year retention period (expires %)',
      v_retention_expires;
  END IF;

  RETURN OLD;
END;
$$;

-- Note: This trigger must fire BEFORE the immutability trigger so we check retention first
CREATE TRIGGER enforce_retention_journal_entries
  BEFORE DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_retention_journal_entries();

-- =============================================================================
-- 7. set_committed_at()
-- BEFORE UPDATE on journal_entries
-- Auto-sets committed_at = now() on draft→posted transition
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    NEW.committed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_committed_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_committed_at();

-- =============================================================================
-- 8. calculate_retention_expiry()
-- BEFORE INSERT/UPDATE on fiscal_periods
-- Auto-sets retention_expires_at = period_end + 7 years
-- =============================================================================
CREATE OR REPLACE FUNCTION public.calculate_retention_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_expires_at := NEW.period_end + INTERVAL '7 years';
  RETURN NEW;
END;
$$;

CREATE TRIGGER calculate_retention_expiry
  BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.calculate_retention_expiry();

-- Backfill existing fiscal periods
UPDATE public.fiscal_periods
SET retention_expires_at = period_end + INTERVAL '7 years'
WHERE retention_expires_at IS NULL;
