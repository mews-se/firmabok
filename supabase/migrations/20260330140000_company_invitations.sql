-- Company invitations table for team member invites
CREATE TABLE public.company_invitations (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            text NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One pending invite per email per company
  UNIQUE (company_id, email)
);

ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;

-- RLS: members of the company can view/manage invitations
CREATE POLICY company_invitations_select ON public.company_invitations
  FOR SELECT USING (
    company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY company_invitations_insert ON public.company_invitations
  FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY company_invitations_update ON public.company_invitations
  FOR UPDATE USING (
    company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY company_invitations_delete ON public.company_invitations
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
  );

-- updated_at trigger
CREATE TRIGGER company_invitations_updated_at
  BEFORE UPDATE ON public.company_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Index for token lookups
CREATE INDEX idx_company_invitations_token_hash ON public.company_invitations(token_hash);

-- Index for listing pending invites
CREATE INDEX idx_company_invitations_company_status ON public.company_invitations(company_id, status);
