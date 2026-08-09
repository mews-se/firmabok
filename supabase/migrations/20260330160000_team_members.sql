-- Migration: Team members & team invitations
--
-- Introduces a "team" layer above companies for consulting firms.
-- A team owner (consultant) invites other consultants to their team.
-- Team members automatically get access to all of the owner's companies.
-- Company-level invites remain for adding clients/viewers to a single company.

-- =============================================================================
-- 1. team_members
-- =============================================================================

CREATE TABLE public.team_members (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member'
               CHECK (role IN ('admin', 'member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (owner_id, user_id),
  CHECK (owner_id <> user_id)
);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER team_members_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: visible to owner and team member
CREATE POLICY "team_members_select" ON public.team_members
  FOR SELECT USING (auth.uid() = owner_id OR auth.uid() = user_id);
CREATE POLICY "team_members_insert" ON public.team_members
  FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "team_members_update" ON public.team_members
  FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "team_members_delete" ON public.team_members
  FOR DELETE USING (auth.uid() = owner_id);

CREATE INDEX idx_team_members_owner_id ON public.team_members (owner_id);
CREATE INDEX idx_team_members_user_id ON public.team_members (user_id);

-- =============================================================================
-- 2. team_invitations
-- =============================================================================

CREATE TABLE public.team_invitations (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  role       text NOT NULL DEFAULT 'member'
               CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (owner_id, email)
);

ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER team_invitations_updated_at
  BEFORE UPDATE ON public.team_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: owner and inviter can see/manage
CREATE POLICY "team_invitations_select" ON public.team_invitations
  FOR SELECT USING (auth.uid() = owner_id OR auth.uid() = invited_by);
CREATE POLICY "team_invitations_insert" ON public.team_invitations
  FOR INSERT WITH CHECK (auth.uid() = owner_id OR auth.uid() = invited_by);
CREATE POLICY "team_invitations_update" ON public.team_invitations
  FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "team_invitations_delete" ON public.team_invitations
  FOR DELETE USING (auth.uid() = owner_id);

CREATE INDEX idx_team_invitations_owner_id ON public.team_invitations (owner_id);
CREATE INDEX idx_team_invitations_token_hash ON public.team_invitations (token_hash);

-- =============================================================================
-- 3. Add source column to company_members
-- =============================================================================
-- Distinguishes between direct invites and team-synced memberships.
-- Team-synced entries are auto-removed when a user is removed from the team.

ALTER TABLE public.company_members
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'direct'
  CHECK (source IN ('direct', 'team'));

-- =============================================================================
-- 4. Auto-sync: team member added → add to all owner's companies
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_team_member_to_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_role text;
BEGIN
  -- Map team role to company role
  v_company_role := CASE NEW.role
    WHEN 'admin' THEN 'admin'
    ELSE 'member'
  END;

  -- Insert into company_members for every company the owner owns
  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT cm.company_id, NEW.user_id, v_company_role, 'team'
  FROM public.company_members cm
  WHERE cm.user_id = NEW.owner_id
    AND cm.role = 'owner'
  ON CONFLICT (company_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER team_member_sync_insert
  AFTER INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_to_companies();

-- =============================================================================
-- 5. Auto-sync: team member removed → remove team-sourced company memberships
-- =============================================================================

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
      SELECT cm.company_id
      FROM public.company_members cm
      WHERE cm.user_id = OLD.owner_id
        AND cm.role = 'owner'
    );

  RETURN OLD;
END;
$$;

CREATE TRIGGER team_member_sync_delete
  BEFORE DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.remove_team_member_from_companies();

-- =============================================================================
-- 6. RPC: sync all team members to a newly created company
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_team_to_company(
  p_company_id uuid,
  p_owner_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT p_company_id, tm.user_id,
    CASE tm.role WHEN 'admin' THEN 'admin' ELSE 'member' END,
    'team'
  FROM public.team_members tm
  WHERE tm.owner_id = p_owner_id
  ON CONFLICT (company_id, user_id) DO NOTHING;
END;
$$;

-- =============================================================================
-- 7. Update create_company_with_owner to auto-add team members
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_company_with_owner(
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

  -- Validate entity_type
  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  -- Create the company
  INSERT INTO public.companies (name, entity_type, created_by)
  VALUES (p_name, p_entity_type, v_user_id)
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
  PERFORM public.sync_team_to_company(v_company_id, v_user_id);

  RETURN v_company_id;
END;
$$;
