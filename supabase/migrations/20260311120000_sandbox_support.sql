-- Sandbox support: is_sandbox column, enforcement trigger bypasses, cleanup functions

-- =============================================================================
-- 1a. Add is_sandbox column to company_settings
-- =============================================================================

ALTER TABLE public.company_settings
  ADD COLUMN is_sandbox boolean NOT NULL DEFAULT false;

CREATE INDEX idx_company_settings_sandbox
  ON public.company_settings (is_sandbox)
  WHERE is_sandbox = true;

-- =============================================================================
-- 1b. Update enforcement triggers to skip for sandbox users
-- =============================================================================

-- enforce_journal_entry_immutability — add sandbox bypass
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Skip enforcement for sandbox users
  IF EXISTS (
    SELECT 1 FROM public.company_settings
    WHERE user_id = COALESCE(OLD.user_id, NEW.user_id) AND is_sandbox = true
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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

-- enforce_journal_entry_line_immutability — add sandbox bypass
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_user_id uuid;
BEGIN
  -- Get the parent entry status and user_id
  SELECT status, user_id INTO v_status, v_user_id
  FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Skip enforcement for sandbox users
  IF EXISTS (
    SELECT 1 FROM public.company_settings
    WHERE user_id = v_user_id AND is_sandbox = true
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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

-- enforce_retention_journal_entries — add sandbox bypass (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retention_expires date;
BEGIN
  -- Skip enforcement for sandbox users
  IF EXISTS (
    SELECT 1 FROM public.company_settings
    WHERE user_id = OLD.user_id AND is_sandbox = true
  ) THEN
    RETURN OLD;
  END IF;

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

-- block_document_deletion — add sandbox bypass (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.block_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_status text;
  v_retention_expires date;
BEGIN
  -- Skip enforcement for sandbox users
  IF EXISTS (
    SELECT 1 FROM public.company_settings
    WHERE user_id = OLD.user_id AND is_sandbox = true
  ) THEN
    RETURN OLD;
  END IF;

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

-- =============================================================================
-- 1c. cleanup_sandbox_user(p_user_id uuid)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_sandbox boolean;
  v_deleted integer := 0;
BEGIN
  -- Verify this is a sandbox user
  SELECT is_sandbox INTO v_is_sandbox
  FROM public.company_settings
  WHERE user_id = p_user_id;

  IF v_is_sandbox IS NOT TRUE THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  -- Clear RESTRICT FKs on document_attachments
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  -- Delete journal entry lines (child of journal_entries)
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  -- Delete journal entries (triggers bypass for sandbox)
  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Delete supplier invoices before suppliers cascade
  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  -- Delete from auth.users — cascades everything else
  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

-- =============================================================================
-- 1d. cleanup_expired_sandbox_users(p_max_age_hours int)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_sandbox_users(p_max_age_hours int DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_total integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT cs.user_id
    FROM public.company_settings cs
    WHERE cs.is_sandbox = true
      AND cs.created_at < now() - interval '1 hour' * p_max_age_hours
  LOOP
    BEGIN
      PERFORM public.cleanup_sandbox_user(v_user_id);
      v_total := v_total + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Failed to clean up sandbox user %: %', v_user_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_total;
END;
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_sandbox_users(int) TO service_role;
