-- Migration: Teams table refactor
--
-- Refactors the team model from an implicit owner_id-based system to an
-- explicit `teams` table. Team members and invitations now reference a
-- team_id instead of an owner_id. Companies can optionally belong to a team.
--
-- Execution order:
--   1. Create teams table + user_team_ids() helper
--   2. Backfill: create teams rows from existing team_members.owner_id
--   3. Add team_id to team_members + team_invitations, backfill, drop owner_id
--   4. Add team_id to companies
--   5. Rewrite sync triggers
--   6. Update create_company_with_owner RPC
--   7. New RPC: create_team_with_owner

-- =============================================================================
-- 1. CREATE teams TABLE
-- =============================================================================

CREATE TABLE public.teams (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER teams_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- NOTE: user_team_ids() helper and RLS policies for teams are created later
-- (after team_members.team_id column exists — see section 3k).

-- =============================================================================
-- 2. BACKFILL: Create teams rows from existing team_members.owner_id
-- =============================================================================
-- For each distinct owner_id in team_members, create a teams row.
-- Use the owner's email from profiles as the team name, falling back to 'Team'.
-- This is a no-op on fresh installs (no team_members rows).

INSERT INTO public.teams (id, name, created_by)
SELECT
  uuid_generate_v4(),
  COALESCE(p.email, 'Team'),
  tm.owner_id
FROM (SELECT DISTINCT owner_id FROM public.team_members) tm
LEFT JOIN public.profiles p ON p.id = tm.owner_id;

-- =============================================================================
-- 3. ADD team_id TO team_members (replace owner_id)
-- =============================================================================

-- 3a. Add nullable team_id column
ALTER TABLE public.team_members
  ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE;

-- 3b. Backfill team_id from the teams we just created (matched by owner_id = created_by)
UPDATE public.team_members tm
SET team_id = t.id
FROM public.teams t
WHERE t.created_by = tm.owner_id;

-- 3c. Insert the owner themselves as a team_members row with role='owner'
-- (The CHECK constraint currently only allows 'admin'|'member', so we must
--  widen it first.)

-- Drop the existing role CHECK constraint
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_role_check;

ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('owner', 'admin', 'member'));

-- Now insert owners as team members
INSERT INTO public.team_members (team_id, user_id, role)
SELECT t.id, t.created_by, 'owner'
FROM public.teams t
WHERE NOT EXISTS (
  SELECT 1 FROM public.team_members tm
  WHERE tm.team_id = t.id AND tm.user_id = t.created_by
)
ON CONFLICT DO NOTHING;

-- 3d. Make team_id NOT NULL now that backfill is done
ALTER TABLE public.team_members
  ALTER COLUMN team_id SET NOT NULL;

-- 3e. Drop old constraints and owner_id column
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_owner_id_user_id_key;

ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_check;

-- 3f. Add new unique constraint
ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_team_id_user_id_key UNIQUE (team_id, user_id);

-- 3g. Drop old indexes
DROP INDEX IF EXISTS idx_team_members_owner_id;

-- 3h. Add new indexes
CREATE INDEX idx_team_members_team_id ON public.team_members (team_id);

-- 3i. Drop old RLS policies that reference owner_id (must happen before column drop)
DROP POLICY IF EXISTS "team_members_select" ON public.team_members;
DROP POLICY IF EXISTS "team_members_insert" ON public.team_members;
DROP POLICY IF EXISTS "team_members_update" ON public.team_members;
DROP POLICY IF EXISTS "team_members_delete" ON public.team_members;

-- 3i. Drop owner_id column
ALTER TABLE public.team_members
  DROP COLUMN owner_id;

-- =============================================================================
-- 3i2. HELPER FUNCTION: user_team_ids()
-- Deferred until here because it references team_members.team_id.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_team_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.teams WHERE created_by = auth.uid()
  UNION
  SELECT team_id FROM public.team_members WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.user_team_ids() TO authenticated;

-- RLS POLICIES for teams
CREATE POLICY "teams_select" ON public.teams
  FOR SELECT USING (id IN (SELECT public.user_team_ids()));
CREATE POLICY "teams_insert" ON public.teams
  FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "teams_update" ON public.teams
  FOR UPDATE USING (id IN (SELECT public.user_team_ids()));

-- =============================================================================
-- 3j. ADD team_id TO team_invitations (replace owner_id)
-- =============================================================================

ALTER TABLE public.team_invitations
  ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE;

-- Backfill from existing owner_id → teams.created_by mapping
UPDATE public.team_invitations ti
SET team_id = t.id
FROM public.teams t
WHERE t.created_by = ti.owner_id;

-- Make team_id NOT NULL
ALTER TABLE public.team_invitations
  ALTER COLUMN team_id SET NOT NULL;

-- Drop old constraints
ALTER TABLE public.team_invitations
  DROP CONSTRAINT IF EXISTS team_invitations_owner_id_email_key;

-- Add new unique constraint
ALTER TABLE public.team_invitations
  ADD CONSTRAINT team_invitations_team_id_email_key UNIQUE (team_id, email);

-- Widen role check to include 'owner'
ALTER TABLE public.team_invitations
  DROP CONSTRAINT IF EXISTS team_invitations_role_check;

ALTER TABLE public.team_invitations
  ADD CONSTRAINT team_invitations_role_check
  CHECK (role IN ('owner', 'admin', 'member'));

-- Drop old indexes
DROP INDEX IF EXISTS idx_team_invitations_owner_id;

-- Add new indexes
CREATE INDEX idx_team_invitations_team_id ON public.team_invitations (team_id);

-- Drop old RLS policies that reference owner_id (must happen before column drop)
DROP POLICY IF EXISTS "team_invitations_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_insert" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_update" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_delete" ON public.team_invitations;

-- Drop owner_id column
ALTER TABLE public.team_invitations
  DROP COLUMN owner_id;

-- =============================================================================
-- 3k. UPDATE RLS POLICIES for team_members
-- =============================================================================

DROP POLICY IF EXISTS "team_members_select" ON public.team_members;
DROP POLICY IF EXISTS "team_members_insert" ON public.team_members;
DROP POLICY IF EXISTS "team_members_update" ON public.team_members;
DROP POLICY IF EXISTS "team_members_delete" ON public.team_members;

CREATE POLICY "team_members_select" ON public.team_members
  FOR SELECT USING (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_members_insert" ON public.team_members
  FOR INSERT WITH CHECK (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_members_update" ON public.team_members
  FOR UPDATE USING (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_members_delete" ON public.team_members
  FOR DELETE USING (team_id IN (SELECT public.user_team_ids()));

-- =============================================================================
-- 3l. UPDATE RLS POLICIES for team_invitations
-- =============================================================================

DROP POLICY IF EXISTS "team_invitations_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_insert" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_update" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_delete" ON public.team_invitations;

CREATE POLICY "team_invitations_select" ON public.team_invitations
  FOR SELECT USING (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_invitations_insert" ON public.team_invitations
  FOR INSERT WITH CHECK (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_invitations_update" ON public.team_invitations
  FOR UPDATE USING (team_id IN (SELECT public.user_team_ids()));
CREATE POLICY "team_invitations_delete" ON public.team_invitations
  FOR DELETE USING (team_id IN (SELECT public.user_team_ids()));

-- =============================================================================
-- 4. ADD team_id TO companies
-- =============================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;

CREATE INDEX idx_companies_team_id ON public.companies (team_id);

-- =============================================================================
-- 5. REWRITE SYNC TRIGGERS
-- =============================================================================
-- Drop old triggers before creating new ones.

DROP TRIGGER IF EXISTS team_member_sync_insert ON public.team_members;
DROP TRIGGER IF EXISTS team_member_sync_delete ON public.team_members;

-- 5a. sync_team_member_to_companies()
-- AFTER INSERT on team_members: insert into company_members for every company
-- where companies.team_id = NEW.team_id

CREATE OR REPLACE FUNCTION public.sync_team_member_to_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_role text;
BEGIN
  -- Map team role to company role (team owner/admin → company admin, else member)
  -- Company 'owner' role is reserved for whoever created that specific company.
  v_company_role := CASE
    WHEN NEW.role IN ('owner', 'admin') THEN 'admin'
    ELSE 'member'
  END;

  -- Insert into company_members for every company belonging to this team
  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT c.id, NEW.user_id, v_company_role, 'team'
  FROM public.companies c
  WHERE c.team_id = NEW.team_id
  ON CONFLICT (company_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER team_member_sync_insert
  AFTER INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_to_companies();

-- 5b. remove_team_member_from_companies()
-- BEFORE DELETE on team_members: delete from company_members where source='team'
-- and company_id in companies where companies.team_id = OLD.team_id

CREATE OR REPLACE FUNCTION public.remove_team_member_from_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.company_members
  WHERE user_id = OLD.user_id
    AND source = 'team'
    AND company_id IN (
      SELECT c.id
      FROM public.companies c
      WHERE c.team_id = OLD.team_id
    );

  RETURN OLD;
END;
$$;

CREATE TRIGGER team_member_sync_delete
  BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.remove_team_member_from_companies();

-- 5c. sync_team_to_company(p_company_id, p_team_id)
-- When a new company is created under a team: add all team members to the company.
-- Drop old signature first (parameter name changed from p_owner_id to p_team_id).
DROP FUNCTION IF EXISTS public.sync_team_to_company(uuid, uuid);

CREATE OR REPLACE FUNCTION public.sync_team_to_company(
  p_company_id uuid,
  p_team_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT p_company_id, tm.user_id,
    CASE
      WHEN tm.role IN ('owner', 'admin') THEN 'admin'
      ELSE 'member'
    END,
    'team'
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id
  ON CONFLICT (company_id, user_id) DO NOTHING;
END;
$$;

-- =============================================================================
-- 6. UPDATE create_company_with_owner RPC
-- =============================================================================
-- Drop old signatures to avoid overload ambiguity, then create with new 4-param signature.
DROP FUNCTION IF EXISTS public.create_company_with_owner(text, text, boolean);
DROP FUNCTION IF EXISTS public.create_company_with_owner(text, text, boolean, uuid);

CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_name text,
  p_entity_type text,
  p_set_active boolean DEFAULT true,
  p_team_id uuid DEFAULT NULL
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

  -- Validate entity_type
  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  -- Create the company (with optional team_id)
  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (p_name, p_entity_type, v_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  -- Create owner membership
  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Set as active company
  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  -- Auto-add team members to the new company
  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

-- Re-grant with new signature (4 params)
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean, uuid) TO authenticated;

-- =============================================================================
-- 7. NEW RPC: create_team_with_owner(p_name text)
-- =============================================================================
-- Creates a teams row with the caller as created_by, inserts the caller into
-- team_members with role='owner'. Returns the team id.

CREATE OR REPLACE FUNCTION public.create_team_with_owner(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_team_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Create the team
  INSERT INTO public.teams (name, created_by)
  VALUES (p_name, v_user_id)
  RETURNING id INTO v_team_id;

  -- Add the creator as an owner member
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, 'owner');

  RETURN v_team_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_team_with_owner(text) TO authenticated;

-- =============================================================================
-- 8. FIX user_preferences.active_company_id FK
-- =============================================================================
-- The original FK has no ON DELETE action (defaults to RESTRICT), which blocks
-- company deletion when a user_preferences row points to that company.
-- Change to ON DELETE SET NULL so deleting a company just clears the preference.

ALTER TABLE public.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_active_company_id_fkey;

ALTER TABLE public.user_preferences
  ADD CONSTRAINT user_preferences_active_company_id_fkey
  FOREIGN KEY (active_company_id)
  REFERENCES public.companies(id)
  ON DELETE SET NULL;

-- =============================================================================
-- 9. UPDATE delete_user_account RPC
-- =============================================================================
-- Clear user_preferences before deleting the user to avoid FK conflicts
-- during the CASCADE chain (companies deleted before user_preferences).

CREATE OR REPLACE FUNCTION public.delete_user_account(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only allow users to delete their own account
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  -- Clear active_company_id to avoid FK conflicts during CASCADE
  DELETE FROM public.user_preferences WHERE user_id = target_user_id;

  -- Explicitly delete from extension_data (missing DELETE RLS policy
  -- causes CASCADE from auth.users to fail even with ON DELETE CASCADE)
  DELETE FROM public.extension_data WHERE user_id = target_user_id;

  -- Disable BEFORE DELETE triggers that block deletion
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log DISABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments DISABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines DISABLE TRIGGER enforce_journal_entry_line_immutability;

  -- Disable AFTER DELETE audit triggers (they INSERT into audit_log during
  -- CASCADE, which would create orphaned rows after the user is gone)
  ALTER TABLE api_keys DISABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts DISABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings DISABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments DISABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data DISABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods DISABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries DISABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices DISABLE TRIGGER audit_supplier_invoices;

  -- Delete from auth.users — ON DELETE CASCADE handles all public tables
  DELETE FROM auth.users WHERE id = target_user_id;

  -- Re-enable all triggers
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log ENABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments ENABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines ENABLE TRIGGER enforce_journal_entry_line_immutability;
  ALTER TABLE api_keys ENABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts ENABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings ENABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments ENABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data ENABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods ENABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries ENABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices ENABLE TRIGGER audit_supplier_invoices;
END;
$$;

-- =============================================================================
-- 10. FIX: Make user_id nullable on tables that the multi-tenant migration missed
-- =============================================================================
-- These tables gained company_id but user_id was left as NOT NULL, causing
-- inserts that only provide company_id to fail.

ALTER TABLE public.fiscal_periods ALTER COLUMN user_id DROP NOT NULL;

-- =============================================================================
-- 11. FIX: Add missing ON DELETE CASCADE to extension_data.user_id FK
-- =============================================================================
-- Migration 020 created the FK without CASCADE, which blocks delete_user_account.
-- Every other table already has ON DELETE CASCADE on user_id.

ALTER TABLE public.extension_data
  DROP CONSTRAINT IF EXISTS extension_data_user_id_fkey;
ALTER TABLE public.extension_data
  ADD CONSTRAINT extension_data_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
