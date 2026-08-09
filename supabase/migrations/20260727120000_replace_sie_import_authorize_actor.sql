-- Security fix: replace_sie_import had NO authorization gate and was callable
-- by `anon`.
--
-- State before this migration (verified against production 2026-07-26):
--   * signature  : replace_sie_import(uuid, uuid)
--   * prosecdef  : true (SECURITY DEFINER, runs as the function owner)
--   * proacl     : {=X/postgres, postgres=X/postgres, anon=X/postgres,
--                   authenticated=X/postgres, service_role=X/postgres}
--     i.e. EXECUTE was held by PUBLIC *and* explicitly by anon.
--   * body       : no company_members lookup, no auth.uid(), no tenant guard,
--                  no "unauthorized" raise, and it calls
--                  set_config('gnubok.allow_delete', 'true', true) which
--                  disarms enforce_journal_entry_immutability,
--                  enforce_journal_entry_line_immutability,
--                  enforce_retention_journal_entries and the document
--                  immutability triggers.
--
-- Net effect: anyone holding the public anon key could POST
-- /rest/v1/rpc/replace_sie_import with an arbitrary company_id + import_id and
-- hard-delete another tenant's imported verifikationer, detach their document
-- attachments, clear the fiscal period's opening-balance pointer and rewind
-- voucher_sequences. The BFL immutability and 7-year retention triggers do not
-- stop it, because the function itself turns them off. This is a cross-tenant
-- data-destruction primitive reachable without authentication.
--
-- The gate: RAISE (42501 insufficient_privilege) unless the resolved actor is
-- an owner or admin of p_company_id. It fails CLOSED: an anon caller has no
-- company_members row, v_caller_role comes back NULL and the function raises
-- before any mutation.
--
-- Why p_user_id exists at all: the app runs both bulk-delete RPCs on the
-- service-role client (rpcClientForBulkDelete in lib/import/sie-import.ts)
-- to escape the authenticator role's 8s statement_timeout. That client is
-- cookie-less, so inside the function auth.uid() is NULL. Without an explicit
-- actor the gate could never match and replace would be permanently broken on
-- hosted, exactly the regression 20260624120000 had to fix for undo. The
-- application passes the authorising user as p_user_id.
--
-- Why p_user_id is only honored for service_role: EXECUTE is granted to
-- `authenticated`, so any signed-in user can call this RPC straight over
-- PostgREST. A plain COALESCE(p_user_id, auth.uid()) would let such a caller
-- pass an owner's UUID as p_user_id and impersonate them into the gate; with
-- a known company/import/owner triple that is a cross-tenant hard delete of
-- posted verifikationer, because the function disarms the immutability and
-- retention triggers via gnubok.allow_delete. The actor is therefore resolved
-- the way list_invoice_delivery_summaries_for_service (20260727100000) does
-- it: p_user_id counts only when auth.role() = 'service_role' (the
-- server-controlled client, which passes the human user it authenticated);
-- every other caller is pinned to its own auth.uid() regardless of what it
-- passes. undo_sie_import gets the identical guard in 20260727121000.
--
-- Signature change: the 2-arg overload is dropped rather than left in place.
-- Keeping it would leave an unrevoked, unguarded entry point behind, and
-- PostgREST could not disambiguate a 2-arg call between the old function and
-- the new one's DEFAULT NULL. The only caller (replaceSIEImport in
-- lib/import/sie-import.ts) is updated in the same change; direct SQL/MCP
-- callers using the 2-arg shape still work through the DEFAULT, and now
-- resolve the actor from auth.uid().
--
-- Privileges: REVOKE from PUBLIC and anon (revoking anon alone is not enough,
-- anon is a member of PUBLIC and the PUBLIC grant would keep it callable).
-- Re-assert the two legitimate callers:
--   * service_role  : the normal path, rpcClientForBulkDelete returns
--                     createServiceClient() whenever SUPABASE_SERVICE_ROLE_KEY
--                     is set (always on hosted, required on self-hosted).
--   * authenticated : the documented fallback in the same helper, which runs
--                     the RPC on the caller's own session client when no
--                     service-role key is configured. The in-function
--                     owner/admin gate scopes that caller to companies they
--                     actually administer, so this is not a privilege
--                     escalation; it mirrors undo_sie_import's current grants.
--
-- Body below is byte-for-byte the production definition plus the guard block
-- and the new parameter. search_path and the 290s statement_timeout are
-- restated because CREATE OR REPLACE FUNCTION silently drops every setting
-- attached via ALTER FUNCTION ... SET (added by 20260629160100); dropping it
-- would revive the 8s-cancellation bug that pg-tests pin
-- (lib/import/__tests__/sie-import.replace.pg.test.ts,
-- tests/pg/sie-rpc-statement-timeout.pg.test.ts).
--
-- pg-test: lib/import/__tests__/sie-import.replace.pg.test.ts

DROP FUNCTION IF EXISTS public.replace_sie_import(uuid, uuid);

CREATE OR REPLACE FUNCTION public.replace_sie_import(
  p_company_id uuid,
  p_import_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  -- shape as list_invoice_delivery_summaries_for_service (20260727100000).
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  -- Authorization gate. Fails closed: an anon/unauthenticated caller has no
  -- company_members row, so v_caller_role is NULL and we raise before any
  -- mutation and before gnubok.allow_delete is ever set. The errcode is
  -- explicit so the route can map this raise to a 403.
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can replace SIE imports'
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
      RAISE EXCEPTION 'Cannot replace SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  -- Detach any documents the user attached to the import's entries.
  -- Files stay in Supabase storage; the document rows become unlinked
  -- and can be re-attached after the next import. We cover both
  -- entry-level and line-level attachments because both FKs are RESTRICT
  -- and the line variant would otherwise block the cascade delete below.
  UPDATE public.document_attachments
     SET journal_entry_id      = NULL,
         journal_entry_line_id = NULL
   WHERE journal_entry_id IN (
     SELECT je.id
       FROM public.journal_entries je
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       = 'import'
        AND je.status            IN ('posted', 'cancelled')
   )
      OR journal_entry_line_id IN (
     SELECT jel.id
       FROM public.journal_entry_lines jel
       JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       = 'import'
        AND je.status            IN ('posted', 'cancelled')
   );

  -- Clear the fiscal-period OB pointer (if it came from this import).
  -- enforce_opening_balance_immutability blocks the change unless we
  -- flip opening_balances_set to false in a separate statement first:
  -- the trigger only raises when both opening_balances_set was true AND
  -- the id is being changed in the same UPDATE.
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

  -- Drop the sie_imports -> opening_balance_entry FK before we delete the
  -- entry it points to (FK is SET NULL on delete, but explicit clear is
  -- clearer and avoids relying on cascade ordering).
  UPDATE public.sie_imports
     SET opening_balance_entry_id = NULL
   WHERE id = p_import_id;

  -- Hard-delete the import's journal entries. Lines cascade. The
  -- 'cancelled' predicate vacuums stragglers from any prior soft-replace
  -- so re-fixing a doubly-replaced period also cleans up the residue.
  WITH deleted AS (
    DELETE FROM public.journal_entries
     WHERE company_id        = p_company_id
       AND fiscal_period_id  = v_fiscal_period_id
       AND source_type       = 'import'
       AND status            IN ('posted', 'cancelled')
    RETURNING id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- Reset voucher_sequences for the period. For each series, set
  -- last_number to the max remaining voucher_number (or 0 if none) so
  -- the next next_voucher_number() call yields the right number whether
  -- the user re-imports straight away (starts at 1) or interleaved
  -- manual entries already occupy higher numbers in the series.
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
     SET status      = 'replaced',
         replaced_at = now()
   WHERE id = p_import_id
     AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

-- Least privilege. Supabase's default privileges grant EXECUTE on every new
-- public function to PUBLIC and to anon/authenticated/service_role, so the
-- CREATE above re-introduced the anon grant: revoke it again, PUBLIC included.
REVOKE EXECUTE ON FUNCTION public.replace_sie_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_sie_import(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_sie_import(uuid, uuid, uuid) IS
  'Hard-deletes a completed SIE import''s verifikationer so the period can be re-imported. Requires the actor to be an owner or admin of p_company_id; p_user_id is honored only for service_role callers, every other caller resolves from its own auth.uid(). Raises 42501 otherwise. Not callable by anon.';

NOTIFY pgrst, 'reload schema';
