-- Capability/entitlement substrate — the single primitive behind the SaaS
-- paywall AND the vision's per-tenant modularity / marketplace.
--
-- A company's access to a feature resolves over TWO orthogonal axes, kept in
-- two separate tables on purpose so they never fight:
--   * ENTITLEMENT (capability_grants)        — "is the company allowed/paid for it?"  written by billing.
--   * ENABLEMENT  (company_capability_config) — "is it turned on?"                      written by the byrå/onboarding/admin.
-- hasCapability(company, key) == entitled(company,key) AND NOT explicitly-disabled(company,key).
--
-- Why this deviates from the standard company-scoped table template:
--   * NO user_id: a grant is owned by a company (or a firm/team), not a user.
--     Billing/trial-seeding/admin write these via the service role; a normal
--     user must NEVER be able to self-grant an entitlement.
--   * SELECT-only RLS for authenticated; INSERT/UPDATE/DELETE are service-role
--     only (service_role bypasses RLS). Mirrors agent_atom_registry.
--   * POLYMORPHIC scope: company_id OR team_id (exactly one). team_id is the
--     already-nullable "firm" axis (companies.team_id) — so per-company billing
--     and firm-level billing ride the same table with zero schema churn later.
--   * NO write_audit_log trigger: company_id is nullable on team-scoped grants
--     (the generic audit trigger assumes a company_id); provenance lives in
--     source + metadata + granted_at here, and metered_events is the usage log.
--
-- The compliance kernel stays OUTSIDE this system — no kernel capability is ever
-- a grantable/removable row.

-- =============================================================================
-- 1. capability_grants — ENTITLEMENT axis
-- =============================================================================
CREATE TABLE public.capability_grants (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  source         text NOT NULL CHECK (source IN ('trial', 'stripe', 'manual', 'comp')),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,            -- NULL = never expires (comp / paid-in-good-standing)
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Exactly one scope: a grant is either company-scoped or firm/team-scoped.
  CONSTRAINT capability_grants_one_scope CHECK (num_nonnulls(company_id, team_id) = 1)
);

-- One row per (scope-entity, capability, source) so billing can UPSERT (extend a
-- trial's expiry, refresh a stripe grant). NULLS NOT DISTINCT (PG15+) makes the
-- nullable scope column behave as a real key component.
CREATE UNIQUE INDEX capability_grants_scope_key_source_uniq
  ON public.capability_grants (company_id, team_id, capability_key, source) NULLS NOT DISTINCT;

CREATE INDEX idx_capability_grants_company_id ON public.capability_grants (company_id);
CREATE INDEX idx_capability_grants_team_id ON public.capability_grants (team_id);
CREATE INDEX idx_capability_grants_key ON public.capability_grants (capability_key);

ALTER TABLE public.capability_grants ENABLE ROW LEVEL SECURITY;

-- Read-only for members of the owning company OR firm/team. No write policy for
-- authenticated by design — grants are written only via the service role
-- (Stripe webhook, trial seeding, admin tooling), so a user can never grant
-- themselves an entitlement.
CREATE POLICY "members read capability_grants"
  ON public.capability_grants FOR SELECT
  USING (
    (company_id IS NOT NULL AND company_id IN (SELECT public.user_company_ids()))
    OR (team_id IS NOT NULL AND team_id IN (SELECT public.user_team_ids()))
  );

CREATE TRIGGER set_updated_at_capability_grants
  BEFORE UPDATE ON public.capability_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. company_capability_config — ENABLEMENT axis
-- =============================================================================
-- Absence of a row == enabled (when entitled). A row with enabled=false is the
-- "entitled but turned off" state (the future modularity-out toggle; no UI yet).
CREATE TABLE public.company_capability_config (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_capability_config_uniq UNIQUE (company_id, capability_key)
);

CREATE INDEX idx_company_capability_config_company_id ON public.company_capability_config (company_id);

ALTER TABLE public.company_capability_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read company_capability_config"
  ON public.company_capability_config FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER set_updated_at_company_capability_config
  BEFORE UPDATE ON public.company_capability_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. metered_events — append-only usage capture
-- =============================================================================
-- Usage cannot be backfilled, so we capture it from day one even though no
-- usage-based pricing exists yet. team_id is denormalized for firm-level rollup.
CREATE TABLE public.metered_events (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  team_id        uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  capability_key text NOT NULL,
  event_type     text NOT NULL,                       -- e.g. 'use', 'auto_commit', 'pack_install'
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  attribution    jsonb NOT NULL DEFAULT '{}'::jsonb   -- { actor_id, actor_kind, pack_id, ... }
);

CREATE INDEX idx_metered_events_company_occurred ON public.metered_events (company_id, occurred_at DESC);
CREATE INDEX idx_metered_events_key ON public.metered_events (capability_key);

ALTER TABLE public.metered_events ENABLE ROW LEVEL SECURITY;

-- Members may read their own usage; rows are written only via the service role
-- (append-only — no UPDATE/DELETE policy for anyone).
CREATE POLICY "members read metered_events"
  ON public.metered_events FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- =============================================================================
-- 4. company_has_capability() — DB-side resolver (defense-in-depth / RLS reuse)
-- =============================================================================
-- The PRIMARY gate is the TS hasCapability() (it must cover the MCP/API-key/cron
-- service-role paths, which bypass the JWT guard below by design). This RPC
-- mirrors that resolution in the DB so RLS policies and other RPCs can gate on a
-- capability, and it reuses the exact jwt-role + user_company_ids() tenant guard
-- shipped in 20260619130100.
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
  v_team_id   uuid;
  v_entitled  boolean;
  v_disabled  boolean;
BEGIN
  -- Tenant guard: anon/authenticated may only ask about their own companies;
  -- service_role / direct access (no JWT role — MCP/API-key/cron, migrations,
  -- pg-real harness) bypasses BY DESIGN, with company scoping enforced in TS.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT team_id INTO v_team_id FROM public.companies WHERE id = p_company_id;

  -- Entitlement axis: any non-expired grant on the company OR its firm/team.
  SELECT EXISTS (
    SELECT 1 FROM public.capability_grants g
    WHERE g.capability_key = p_capability_key
      AND (
        g.company_id = p_company_id
        OR (v_team_id IS NOT NULL AND g.team_id = v_team_id)
      )
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

REVOKE ALL ON FUNCTION public.company_has_capability(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_has_capability(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
