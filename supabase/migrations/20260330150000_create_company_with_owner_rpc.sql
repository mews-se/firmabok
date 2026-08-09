-- Migration: RPC to atomically create a company + owner membership
--
-- Fixes RLS chicken-and-egg: user can't INSERT INTO companies with RETURNING
-- because the SELECT policy requires company_members, which doesn't exist yet.
-- Similarly, company_members INSERT requires existing membership.
--
-- This SECURITY DEFINER function bypasses RLS to bootstrap the first membership.

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

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean) TO authenticated;
