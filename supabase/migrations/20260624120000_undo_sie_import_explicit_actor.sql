-- Fix: undo_sie_import owner/admin gate breaks when the RPC runs on the
-- service-role client.
--
-- Background: 20260528120100_undo_sie_import.sql checks the caller's role with
--   WHERE cm.user_id = auth.uid()
-- and raises 'Only company owners and admins can undo SIE imports' when no
-- owner/admin row matches.
--
-- A later change (commit ade0cd66 "run SIE bulk-delete RPCs on the service
-- client") routes this RPC through createServiceClient() to escape the 8s
-- statement_timeout on large imports. That client is cookie-less and sends the
-- service-role key as the JWT, so inside the RPC auth.uid() is NULL — the role
-- lookup matches nothing and the function ALWAYS raises. undo_sie_import is
-- therefore completely broken on hosted (where SUPABASE_SERVICE_ROLE_KEY is
-- set): "Kunde inte ångra import: Only company owners and admins can undo SIE
-- imports".
--
-- Fix: accept the authorising user explicitly as p_user_id and resolve the
-- role against COALESCE(p_user_id, auth.uid()). The application layer (API
-- route / pending-operation commit) already has the human user's id and now
-- passes it through. Backward compatible: callers using a real user JWT and no
-- p_user_id (e.g. a direct SQL/MCP call) still resolve via auth.uid().
--
-- The 2-arg signature is dropped first so PostgREST has a single, unambiguous
-- overload to resolve the RPC against.
--
-- Audit note: the behandlingshistorik (per-row audit_log on each
-- journal_entries DELETE) is written by write_audit_log(), which records the
-- entry's own user_id — NOT auth.uid() — so the deletion trail is unaffected
-- by which client runs the RPC. This change only restores the authorisation
-- gate; it does not alter what gets logged.
--
-- pg-test: lib/import/__tests__/undo-sie-import-actor.pg.test.ts

DROP FUNCTION IF EXISTS public.undo_sie_import(uuid, uuid);

CREATE OR REPLACE FUNCTION public.undo_sie_import(
  p_company_id uuid,
  p_import_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
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
  v_actor                     uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

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
