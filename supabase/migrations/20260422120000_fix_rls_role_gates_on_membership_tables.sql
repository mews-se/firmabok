-- =============================================================================
-- Fix RLS escalation across multi-tenant authorization layer.
--
-- The INSERT/UPDATE/DELETE policies defined in
--   20260330130000_multi_tenant_company_refactor.sql
--   20260330140000_company_invitations.sql
--   20260331010000_teams_table_refactor.sql
-- gated writes only on `user_company_ids()` / `user_team_ids()` — i.e. any
-- membership regardless of role. This allowed a user with role='viewer' to
-- issue a direct PATCH against PostgREST and promote themselves to 'owner'
-- (confirmed in production), bypassing the app-layer requireWritePermission
-- guard entirely.
--
-- Fix: require the caller to hold role IN ('owner','admin') in the target
-- company/team for every write on the authorization-sensitive tables. All
-- legitimate app flows write via service role or SECURITY DEFINER RPCs/
-- triggers, which bypass RLS — so these tightened policies only block
-- direct PostgREST calls from user sessions, which was the exploit path.
--
-- Role check is wrapped in SECURITY DEFINER helpers (user_is_company_admin,
-- user_is_team_admin) matching the existing user_company_ids() pattern.
-- This is necessary because inlining `EXISTS (SELECT ... FROM company_members)`
-- inside a policy ON company_members is detected by Postgres as recursive.
-- SECURITY DEFINER functions bypass RLS internally, breaking the cycle.
--
-- Additionally: a BEFORE UPDATE trigger on company_members blocks any role
-- change unless the caller already holds role='owner'. This reserves
-- promotion to 'owner' (or demotion of one) to existing owners — admins
-- cannot mint further owners even though they can otherwise write.
-- =============================================================================

-- =============================================================================
-- 1. SECURITY DEFINER helper functions
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_is_company_admin(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('owner', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_company_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.user_is_team_admin(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = p_team_id
      AND tm.user_id = auth.uid()
      AND tm.role IN ('owner', 'admin')
  ) OR EXISTS (
    SELECT 1 FROM public.teams t
    WHERE t.id = p_team_id
      AND t.created_by = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_team_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.user_role_in_company(p_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.company_members
  WHERE company_id = p_company_id AND user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.user_role_in_company(uuid) TO authenticated;

-- =============================================================================
-- 2. company_members — tighten write policies
-- =============================================================================

DROP POLICY IF EXISTS "company_members_insert" ON public.company_members;
DROP POLICY IF EXISTS "company_members_update" ON public.company_members;
DROP POLICY IF EXISTS "company_members_delete" ON public.company_members;

CREATE POLICY "company_members_insert" ON public.company_members
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "company_members_update" ON public.company_members
  FOR UPDATE
  USING (public.user_is_company_admin(company_id))
  WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "company_members_delete" ON public.company_members
  FOR DELETE USING (public.user_is_company_admin(company_id));

-- =============================================================================
-- 3. team_members — tighten write policies
-- =============================================================================

DROP POLICY IF EXISTS "team_members_insert" ON public.team_members;
DROP POLICY IF EXISTS "team_members_update" ON public.team_members;
DROP POLICY IF EXISTS "team_members_delete" ON public.team_members;

CREATE POLICY "team_members_insert" ON public.team_members
  FOR INSERT WITH CHECK (public.user_is_team_admin(team_id));

CREATE POLICY "team_members_update" ON public.team_members
  FOR UPDATE
  USING (public.user_is_team_admin(team_id))
  WITH CHECK (public.user_is_team_admin(team_id));

CREATE POLICY "team_members_delete" ON public.team_members
  FOR DELETE USING (public.user_is_team_admin(team_id));

-- =============================================================================
-- 4. api_keys — tighten write policies
-- A viewer minting an API key with broad scopes is catastrophic.
-- =============================================================================

DROP POLICY IF EXISTS "api_keys_insert" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys_update" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys_delete" ON public.api_keys;

CREATE POLICY "api_keys_insert" ON public.api_keys
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "api_keys_update" ON public.api_keys
  FOR UPDATE
  USING (public.user_is_company_admin(company_id))
  WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "api_keys_delete" ON public.api_keys
  FOR DELETE USING (public.user_is_company_admin(company_id));

-- =============================================================================
-- 5. company_invitations — tighten write policies
-- =============================================================================

DROP POLICY IF EXISTS "company_invitations_insert" ON public.company_invitations;
DROP POLICY IF EXISTS "company_invitations_update" ON public.company_invitations;
DROP POLICY IF EXISTS "company_invitations_delete" ON public.company_invitations;

CREATE POLICY "company_invitations_insert" ON public.company_invitations
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "company_invitations_update" ON public.company_invitations
  FOR UPDATE
  USING (public.user_is_company_admin(company_id))
  WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "company_invitations_delete" ON public.company_invitations
  FOR DELETE USING (public.user_is_company_admin(company_id));

-- =============================================================================
-- 6. team_invitations — tighten write policies
-- =============================================================================

DROP POLICY IF EXISTS "team_invitations_insert" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_update" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_delete" ON public.team_invitations;

CREATE POLICY "team_invitations_insert" ON public.team_invitations
  FOR INSERT WITH CHECK (public.user_is_team_admin(team_id));

CREATE POLICY "team_invitations_update" ON public.team_invitations
  FOR UPDATE
  USING (public.user_is_team_admin(team_id))
  WITH CHECK (public.user_is_team_admin(team_id));

CREATE POLICY "team_invitations_delete" ON public.team_invitations
  FOR DELETE USING (public.user_is_team_admin(team_id));

-- =============================================================================
-- 7. companies — tighten UPDATE policy (INSERT keeps created_by check)
-- =============================================================================

DROP POLICY IF EXISTS "companies_update" ON public.companies;

CREATE POLICY "companies_update" ON public.companies
  FOR UPDATE
  USING (public.user_is_company_admin(id))
  WITH CHECK (public.user_is_company_admin(id));

-- =============================================================================
-- 8. teams — tighten UPDATE policy (INSERT keeps created_by check)
-- =============================================================================

DROP POLICY IF EXISTS "teams_update" ON public.teams;

CREATE POLICY "teams_update" ON public.teams
  FOR UPDATE
  USING (public.user_is_team_admin(id) OR created_by = auth.uid())
  WITH CHECK (public.user_is_team_admin(id) OR created_by = auth.uid());

-- =============================================================================
-- 9. company_settings — tighten write policies
-- =============================================================================

DROP POLICY IF EXISTS "company_settings_insert" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_update" ON public.company_settings;

CREATE POLICY "company_settings_insert" ON public.company_settings
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));

CREATE POLICY "company_settings_update" ON public.company_settings
  FOR UPDATE
  USING (public.user_is_company_admin(company_id))
  WITH CHECK (public.user_is_company_admin(company_id));

-- =============================================================================
-- 10. BEFORE UPDATE trigger on company_members:
--     block role transitions unless the caller already holds role='owner'.
-- Service role / SECURITY DEFINER / direct SQL (migration apply) pass through
-- because auth.uid() is NULL in those contexts.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_company_member_role_transitions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Service role, SECURITY DEFINER cascades, and direct SQL have no auth context.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nothing to enforce if the role field isn't changing.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  caller_role := public.user_role_in_company(OLD.company_id);

  IF caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION
      'Only owners can change member roles (your role: %)',
      COALESCE(caller_role, 'none');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_company_member_role_transitions
  ON public.company_members;

CREATE TRIGGER enforce_company_member_role_transitions
  BEFORE UPDATE ON public.company_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_company_member_role_transitions();

-- Force PostgREST to pick up the new policies immediately.
NOTIFY pgrst, 'reload schema';
