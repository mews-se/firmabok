-- =============================================================================
-- Close INSERT bypass in company_members owner-role guard.
--
-- 20260422120000_fix_rls_role_gates_on_membership_tables.sql added a
-- BEFORE UPDATE trigger that blocks non-owners from promoting members to
-- role='owner'. The trigger fires only on UPDATE, and the INSERT policy
-- (company_members_insert) passes any caller with role IN ('owner','admin')
-- with no constraint on NEW.role. An admin could therefore bypass the guard
-- entirely via a direct PostgREST INSERT with role='owner', contradicting
-- the stated guarantee that only owners can mint further owners.
--
-- Fix: add a BEFORE INSERT trigger that blocks role='owner' unless the
-- caller already holds role='owner' in the target company.
--
-- Bootstrap case: create_company_with_owner() (SECURITY DEFINER RPC)
-- preserves auth.uid() while inserting the first owner membership for a
-- freshly created company. The trigger must allow this path. The helper
-- user_role_in_company() returns NULL at that moment (no prior membership),
-- so we permit the insert when (a) the caller is inserting themselves and
-- (b) the company has no existing owner. Both conditions together pin the
-- escape hatch to genuine first-time bootstrap; a subsequent attempt to
-- inject a second owner fails on condition (b).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_company_member_role_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Service role and direct SQL (migration apply, admin console) have no
  -- auth context; pass through unchanged.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only the 'owner' role is gated; admin/member/viewer pass through so that
  -- admins retain the ability to add non-owner members.
  IF NEW.role IS DISTINCT FROM 'owner' THEN
    RETURN NEW;
  END IF;

  caller_role := public.user_role_in_company(NEW.company_id);

  -- Existing owners can always mint owners.
  IF caller_role = 'owner' THEN
    RETURN NEW;
  END IF;

  -- Bootstrap: create_company_with_owner RPC inserts the first owner
  -- membership. The caller has no prior membership (caller_role IS NULL)
  -- and inserts themselves. Reject if an owner already exists to prevent
  -- this path from being reused to mint a second owner.
  IF caller_role IS NULL
     AND NEW.user_id = auth.uid()
     AND NOT EXISTS (
       SELECT 1 FROM public.company_members
       WHERE company_id = NEW.company_id
         AND role = 'owner'
     )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Only owners can add members with role ''owner'' (your role: %)',
    COALESCE(caller_role, 'none');
END;
$$;

DROP TRIGGER IF EXISTS enforce_company_member_role_on_insert
  ON public.company_members;

CREATE TRIGGER enforce_company_member_role_on_insert
  BEFORE INSERT ON public.company_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_company_member_role_on_insert();

NOTIFY pgrst, 'reload schema';
