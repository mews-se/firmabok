-- Security fix: undo_sie_import trusted p_user_id from ANY caller.
--
-- The shipped definition (20260624120000, body last restated by
-- 20260702154500) resolves its owner/admin gate from
-- COALESCE(p_user_id, auth.uid()) while EXECUTE is held by `authenticated`
-- (Supabase default privileges; no migration ever revoked them). Any signed-in
-- user could therefore POST /rest/v1/rpc/undo_sie_import with an owner's UUID
-- as p_user_id and impersonate them: the gate passes, the function sets
-- gnubok.allow_delete and disarms the BFL immutability/retention triggers, and
-- another tenant's posted verifikationer are hard-deleted. All it takes is a
-- known company/import/owner triple. This is the same hole 20260727120000
-- closes for replace_sie_import; the guard shape is identical and mirrors
-- list_invoice_delivery_summaries_for_service (20260727100000).
--
-- The fix: p_user_id is honored only when auth.role() = 'service_role' (the
-- cookieless server client, which passes the human user it authenticated and
-- where auth.uid() is NULL); every other caller is pinned to its own
-- auth.uid() regardless of what it passes. The two legitimate paths keep
-- working unchanged:
--   * service client (rpcClientForBulkDelete in lib/import/sie-import.ts):
--     auth.uid() NULL, auth.role() = 'service_role', p_user_id used;
--   * session-client fallback (no SUPABASE_SERVICE_ROLE_KEY): the caller's
--     own auth.uid() wins regardless of p_user_id.
--
-- The body below is byte-for-byte the 20260702154500 definition (the latest:
-- it added the dimension-registry lockstep) plus the actor-resolution block
-- and the explicit 42501 errcode on the authorization raise. search_path and
-- the 290s statement_timeout are restated because CREATE OR REPLACE FUNCTION
-- drops settings attached via ALTER FUNCTION ... SET (20260629160100);
-- dropping the timeout would revive the 8s-cancellation bug pinned by
-- tests/pg/sie-rpc-statement-timeout.pg.test.ts.
--
-- Privileges: the function had only the Supabase default grants, which
-- include PUBLIC and anon. The gate fails closed for anon (no membership,
-- auth.uid() NULL), but there is no reason to leave the entry point callable
-- at all: apply the same least-privilege discipline as replace_sie_import.
--
-- pg-test: lib/import/__tests__/undo-sie-import-actor.pg.test.ts (the spoof
-- rejection, the 42501 errcode and the tightened grants are pinned there)

CREATE OR REPLACE FUNCTION public.undo_sie_import(
  p_company_id uuid,
  p_import_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 -- CREATE OR REPLACE resets proconfig, so the function-local timeout from
 -- 20260629160100 must be restated here or the service-client bulk delete
 -- regresses to the authenticator role's 8s limit (pinned by
 -- sie-import.replace.pg.test.ts).
 SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_fiscal_period_id          uuid;
  v_opening_balance_entry_id  uuid;
  v_is_closed                 boolean;
  v_locked_at                 timestamptz;
  v_deleted                   integer := 0;
  v_caller_role               text;
  v_actor                     uuid;
BEGIN
  -- Actor resolution. p_user_id is an assertion by the caller, so it is
  -- honored ONLY when the caller holds the service role (the cookieless
  -- server client, where auth.uid() is NULL). Any other caller is pinned to
  -- its own auth.uid(): otherwise an authenticated PostgREST caller could
  -- pass an owner's UUID and walk straight through the gate below. Same
  -- shape as replace_sie_import (20260727120000).
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo SIE imports'
      USING ERRCODE = '42501';
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

  -- Registry lockstep (dimensions plan PR5): remove dimension VALUES this
  -- import introduced, unless a remaining posted/reversed line still
  -- references the code (other imports, manual bookkeeping). User-created
  -- rows have created_by_import_id NULL and are never touched.
  DELETE FROM public.dimension_values dv
   USING public.dimensions d
   WHERE dv.created_by_import_id = p_import_id
     AND dv.company_id           = p_company_id
     AND d.id                    = dv.dimension_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.journal_entries je
         JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.company_id = p_company_id
          AND je.status IN ('posted', 'reversed')
          AND jel.dimensions ->> d.sie_dim_no::text = dv.code
     );

  -- ...and custom DIMENSIONS this import introduced that are now empty and
  -- unreferenced. System dims (1/6) are never import-created and are
  -- trigger-protected regardless.
  DELETE FROM public.dimensions d
   WHERE d.created_by_import_id = p_import_id
     AND d.company_id           = p_company_id
     AND d.is_system            = false
     AND NOT EXISTS (
       SELECT 1 FROM public.dimension_values dv WHERE dv.dimension_id = d.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.journal_entries je
         JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.company_id = p_company_id
          AND je.status IN ('posted', 'reversed')
          AND jel.dimensions ? d.sie_dim_no::text
     );

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

-- Least privilege, same discipline as replace_sie_import (20260727120000):
-- the CREATE OR REPLACE keeps whatever grants the function had, which were
-- the Supabase defaults (PUBLIC + anon + authenticated + service_role), so
-- PUBLIC and anon are revoked explicitly and the two legitimate callers are
-- re-asserted: service_role for the normal server path, authenticated for
-- the documented session-client fallback (scoped by the in-function
-- owner/admin gate).
REVOKE EXECUTE ON FUNCTION public.undo_sie_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_sie_import(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.undo_sie_import(uuid, uuid, uuid) IS
  'Hard-deletes a completed SIE import''s verifikationer (incl. opening balance) without requiring a replacement file. Requires the actor to be an owner or admin of p_company_id; p_user_id is honored only for service_role callers, every other caller resolves from its own auth.uid(). Raises 42501 otherwise. Not callable by anon.';

NOTIFY pgrst, 'reload schema';
