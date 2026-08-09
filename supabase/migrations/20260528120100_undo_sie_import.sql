-- Add undo_sie_import RPC and 'undone' status for sie_imports.
--
-- Background: replace_sie_import already hard-deletes a prior import's
-- entries and inserts a replacement. Customers want a one-step "Ångra
-- import" that performs the hard-delete portion without requiring a
-- replacement file (Fortnox/Bokio behavior). This factors the deletion
-- body into a separate RPC.
--
-- Design choice: do NOT call replace_sie_import internally — the source
-- of truth is identical but replace_sie_import marks status='replaced',
-- whereas an undo should be distinguishable for audit (status='undone'),
-- so the body is duplicated rather than parameterized. The shape mirrors
-- 20260526120000_fix_replace_sie_import_hard_delete.sql exactly.

ALTER TABLE public.sie_imports DROP CONSTRAINT IF EXISTS sie_imports_status_check;
ALTER TABLE public.sie_imports ADD CONSTRAINT sie_imports_status_check
  CHECK (status = ANY (ARRAY['pending','mapped','completed','failed','replaced','undone']));

CREATE OR REPLACE FUNCTION public.undo_sie_import(p_company_id uuid, p_import_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fiscal_period_id          uuid;
  v_opening_balance_entry_id  uuid;
  v_is_closed                 boolean;
  v_locked_at                 timestamptz;
  v_deleted                   integer := 0;
  v_caller_role               text;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo SIE imports';
  END IF;

  SELECT fiscal_period_id, opening_balance_entry_id
    INTO v_fiscal_period_id, v_opening_balance_entry_id
    FROM public.sie_imports
   WHERE id = p_import_id
     AND company_id = p_company_id
     AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found or not in completed status', p_import_id;
  END IF;

  IF v_fiscal_period_id IS NOT NULL THEN
    SELECT is_closed, locked_at
      INTO v_is_closed, v_locked_at
      FROM public.fiscal_periods
     WHERE id = v_fiscal_period_id;

    IF v_is_closed OR v_locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot undo SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  -- Detach documents (entry- and line-level).
  UPDATE public.document_attachments
     SET journal_entry_id      = NULL,
         journal_entry_line_id = NULL
   WHERE journal_entry_id IN (
     SELECT je.id
       FROM public.journal_entries je
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       IN ('import', 'opening_balance')
        AND je.status            IN ('posted', 'cancelled')
   )
      OR journal_entry_line_id IN (
     SELECT jel.id
       FROM public.journal_entry_lines jel
       JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       IN ('import', 'opening_balance')
        AND je.status            IN ('posted', 'cancelled')
   );

  -- Clear the fiscal-period OB pointer (two-step around
  -- enforce_opening_balance_immutability).
  IF v_opening_balance_entry_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
       SET opening_balances_set = false
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;

    UPDATE public.fiscal_periods
       SET opening_balance_entry_id = NULL
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;
  END IF;

  -- Drop the sie_imports -> opening_balance_entry FK before delete.
  UPDATE public.sie_imports
     SET opening_balance_entry_id = NULL
   WHERE id = p_import_id;

  -- Hard-delete the import's journal entries (both transaction vouchers
  -- and the opening_balance entry).
  WITH deleted AS (
    DELETE FROM public.journal_entries
     WHERE company_id        = p_company_id
       AND fiscal_period_id  = v_fiscal_period_id
       AND source_type       IN ('import', 'opening_balance')
       AND status            IN ('posted', 'cancelled')
    RETURNING id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- Reset voucher_sequences per series to the max remaining number.
  UPDATE public.voucher_sequences vs
     SET last_number = COALESCE((
           SELECT MAX(je.voucher_number)
             FROM public.journal_entries je
            WHERE je.company_id       = vs.company_id
              AND je.fiscal_period_id = vs.fiscal_period_id
              AND je.voucher_series   = vs.voucher_series
              AND je.voucher_number  > 0
         ), 0),
         updated_at = now()
   WHERE vs.company_id        = p_company_id
     AND vs.fiscal_period_id  = v_fiscal_period_id;

  UPDATE public.sie_imports
     SET status      = 'undone',
         replaced_at = now()
   WHERE id = p_import_id
     AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

NOTIFY pgrst, 'reload schema';
