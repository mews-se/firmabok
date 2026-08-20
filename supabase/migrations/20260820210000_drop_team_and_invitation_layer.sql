-- Migration: drop the team and invitation layer
--
-- The app no longer has team/consulting-firm features, member invitations
-- or multi-company management: a self-hosted installation serves a single
-- operator. This migration removes the schema behind those features:
--
--   * company_invitations (company-level member invites)
--   * teams, team_members, team_invitations (the consulting-firm layer)
--   * companies.team_id and every function/trigger/policy on the team axis
--   * the team scope on booking_template_library, capability_grants and
--     metered_events
--
-- company_members stays untouched: it is the tenancy backbone every RLS
-- policy resolves through (user_company_ids()).
--
-- Policies that referenced the team tables are recreated on company_members
-- BEFORE the tables are dropped, so no window exists where a policy body
-- references a missing relation.

-- =============================================================================
-- 1. voucher_gap_explanations: the role gate went through team_members
--    (team admins JOIN companies ON team_id). Gate on the company_members
--    role instead: same owner/admin semantics, no team involved.
-- =============================================================================

DROP POLICY IF EXISTS voucher_gap_explanations_insert ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_insert ON public.voucher_gap_explanations FOR INSERT TO public
  WITH CHECK (
    company_id = current_active_company_id()
    AND current_user_can_write()
    AND EXISTS (
      SELECT 1
      FROM public.company_members cm
      WHERE cm.company_id = voucher_gap_explanations.company_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS voucher_gap_explanations_update ON public.voucher_gap_explanations;
CREATE POLICY voucher_gap_explanations_update ON public.voucher_gap_explanations FOR UPDATE TO public
  USING (
    company_id = current_active_company_id()
    AND current_user_can_write()
    AND EXISTS (
      SELECT 1
      FROM public.company_members cm
      WHERE cm.company_id = voucher_gap_explanations.company_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

-- =============================================================================
-- 2. booking_template_library: drop the team scope. Team-shared rows have no
--    owner once teams are gone; delete them rather than orphan them.
-- =============================================================================

DELETE FROM public.booking_template_library WHERE team_id IS NOT NULL;

DROP POLICY IF EXISTS btl_select ON public.booking_template_library;
DROP POLICY IF EXISTS btl_insert ON public.booking_template_library;
DROP POLICY IF EXISTS btl_update ON public.booking_template_library;
DROP POLICY IF EXISTS btl_delete ON public.booking_template_library;

-- CASCADE takes the CHECK constraints and the partial index that mention
-- team_id; the surviving constraints are re-added in two-scope form below.
ALTER TABLE public.booking_template_library DROP COLUMN team_id CASCADE;

ALTER TABLE public.booking_template_library
  ADD CONSTRAINT btl_system_scope CHECK (NOT is_system OR company_id IS NULL),
  ADD CONSTRAINT btl_has_scope CHECK (company_id IS NOT NULL OR is_system);

CREATE POLICY btl_select ON public.booking_template_library FOR SELECT TO public
  USING (is_system OR company_id IN (SELECT public.user_company_ids()));

CREATE POLICY btl_insert ON public.booking_template_library FOR INSERT TO public
  WITH CHECK (
    NOT is_system
    AND current_user_can_write()
    AND company_id = current_active_company_id()
  );

CREATE POLICY btl_update ON public.booking_template_library FOR UPDATE TO public
  USING (
    NOT is_system
    AND current_user_can_write()
    AND company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY btl_delete ON public.booking_template_library FOR DELETE TO public
  USING (
    NOT is_system
    AND current_user_can_write()
    AND company_id IN (SELECT public.user_company_ids())
  );

-- =============================================================================
-- 3. capability_grants + metered_events: drop the firm/team scope axis.
-- =============================================================================

DELETE FROM public.capability_grants WHERE team_id IS NOT NULL;

DROP POLICY IF EXISTS "members read capability_grants" ON public.capability_grants;

-- CASCADE takes the one-scope CHECK, the team index and the NULLS NOT
-- DISTINCT unique index.
ALTER TABLE public.capability_grants DROP COLUMN team_id CASCADE;
ALTER TABLE public.capability_grants ALTER COLUMN company_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_capability_grants_scope
  ON public.capability_grants (company_id, capability_key, source);

CREATE POLICY "members read capability_grants"
  ON public.capability_grants FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

ALTER TABLE public.metered_events DROP COLUMN team_id;

-- company_has_capability: same resolver without the firm/team arm.
CREATE OR REPLACE FUNCTION public.company_has_capability(
  p_company_id uuid,
  p_capability_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role  text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_entitled  boolean;
  v_disabled  boolean;
BEGIN
  -- Tenant guard: anon/authenticated may only ask about their own companies;
  -- service_role / direct access (no JWT role: MCP/API-key/cron, migrations,
  -- pg-real harness) bypasses BY DESIGN, with company scoping enforced in TS.
  -- NULL-safe via caller_is_company_member (20260703180000).
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Entitlement axis: any non-expired grant on the company.
  SELECT EXISTS (
    SELECT 1 FROM public.capability_grants g
    WHERE g.capability_key = p_capability_key
      AND g.company_id = p_company_id
      AND (g.expires_at IS NULL OR g.expires_at > now())
  ) INTO v_entitled;

  IF NOT v_entitled THEN
    RETURN false;  -- fail-closed
  END IF;

  -- Enablement axis: explicitly turned off for this company? (absence == enabled)
  SELECT EXISTS (
    SELECT 1 FROM public.company_capability_config c
    WHERE c.company_id = p_company_id
      AND c.capability_key = p_capability_key
      AND c.enabled = false
  ) INTO v_disabled;

  RETURN NOT v_disabled;
END;
$$;

-- =============================================================================
-- 4. create_company_with_owner: recreate without the team argument. The old
--    4-arg signature must be dropped explicitly (removing a defaulted arg is
--    a signature change, not a replace).
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_company_with_owner(text, text, boolean, uuid);

CREATE FUNCTION public.create_company_with_owner(
  p_name text,
  p_entity_type text,
  p_set_active boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by)
  VALUES (p_name, p_entity_type, v_user_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Seed default 1930 SEK cash account so reconciliation routes work from
  -- day one. is_primary so the __PRIMARY_SEK__ sentinel in skattekonto
  -- booking resolves immediately.
  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean) TO authenticated;

-- =============================================================================
-- 5. companies.team_id: CASCADE takes the FK to teams.
-- =============================================================================

ALTER TABLE public.companies DROP COLUMN team_id CASCADE;

-- =============================================================================
-- 6. Team functions, triggers and tables. Triggers on the tables go with
--    them (CASCADE); the trigger functions and helpers are dropped
--    explicitly. Order: tables first, then the functions their policies and
--    triggers referenced.
-- =============================================================================

DROP TABLE IF EXISTS public.team_invitations CASCADE;
DROP TABLE IF EXISTS public.team_members CASCADE;
DROP TABLE IF EXISTS public.teams CASCADE;

DROP FUNCTION IF EXISTS public.sync_team_member_to_companies();
DROP FUNCTION IF EXISTS public.remove_team_member_from_companies();
DROP FUNCTION IF EXISTS public.sync_team_to_company(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_team_with_owner(text);
DROP FUNCTION IF EXISTS public.ensure_user_team();
DROP FUNCTION IF EXISTS public.user_is_team_admin(uuid);
DROP FUNCTION IF EXISTS public.user_team_ids();

-- =============================================================================
-- 7. company_invitations.
-- =============================================================================

DROP TABLE IF EXISTS public.company_invitations CASCADE;

-- =============================================================================
-- 8. anonymize_user_account: same function minus the team_members delete
--    (plpgsql bodies are not validated at CREATE time, so the stale
--    reference would only have exploded at the first real deletion).
--    Everything else is byte for byte the 20260724150000 version.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.anonymize_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  blocker_count int;
BEGIN
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  -- Reject repeat invocations against an already-anonymized tombstone: the
  -- account is gone, re-running would only churn the scrubbed row.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = target_user_id AND anonymized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Account is already deleted' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO blocker_count
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = target_user_id
    AND cm.role = 'owner'
    AND c.archived_at IS NULL;

  IF blocker_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete account: user still owns % active compan(y/ies)', blocker_count
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.company_members   WHERE user_id = target_user_id;
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;

  DELETE FROM public.user_preferences WHERE user_id = target_user_id;
  DELETE FROM public.api_keys         WHERE user_id = target_user_id;

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = now(),
         anonymized_at = now(),
         updated_at    = now()
   WHERE id = target_user_id;

  -- Scrub PII from the auth tombstone. auth.users.email is intentionally
  -- kept (blocks re-signup + lets support verify identity for BFL-retained
  -- data recovery; documented legitimate interest, see
  -- app/api/account/delete/route.ts).
  UPDATE auth.users
     SET raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
   WHERE id = target_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.anonymize_user_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_user_account(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
