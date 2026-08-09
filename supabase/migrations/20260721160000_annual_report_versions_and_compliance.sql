-- Versioned annual reports, explicit K2 eligibility facts, disclosure
-- confirmations, signature evidence, and safer Bolagsverket submission state.

CREATE TABLE public.annual_report_profiles (
  id                                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id                        uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  user_id                                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_public_limited_company               boolean,
  is_in_liquidation                       boolean,
  securities_traded_on_regulated_market  boolean,
  is_parent_company                       boolean,
  parent_group_size                       text CHECK (parent_group_size IN ('none', 'small', 'large')),
  prepares_consolidated_accounts          boolean,
  has_foreign_branch                      boolean,
  has_crypto_assets                       boolean,
  has_share_based_payments                boolean,
  has_convertible_debt                    boolean,
  building_revenue_share_pct              numeric(5, 2) CHECK (
    building_revenue_share_pct IS NULL
    OR building_revenue_share_pct BETWEEN 0 AND 100
  ),
  has_material_deferred_tax               boolean,
  reporting_currency                      text NOT NULL DEFAULT 'SEK' CHECK (reporting_currency IN ('SEK', 'EUR')),
  auditor_report_required                 boolean,
  auditor_report_included                 boolean NOT NULL DEFAULT false,
  dividend_prudence_confirmed             boolean,
  narrative_confirmed_at                  timestamptz,
  k2_assessment_confirmed_at               timestamptz,
  signer_roster_confirmed_at               timestamptz,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  updated_at                              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT annual_report_profiles_company_period_unique UNIQUE (company_id, fiscal_period_id),
  CONSTRAINT annual_report_profiles_parent_consistency CHECK (
    is_parent_company IS NOT false
    OR (parent_group_size IS NULL AND prepares_consolidated_accounts IS NOT true)
  )
);

CREATE INDEX idx_annual_report_profiles_period
  ON public.annual_report_profiles (company_id, fiscal_period_id);

ALTER TABLE public.annual_report_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY annual_report_profiles_select ON public.annual_report_profiles
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY annual_report_profiles_insert ON public.annual_report_profiles
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_profiles.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
    AND (user_id IS NULL OR user_id = auth.uid())
  );
CREATE POLICY annual_report_profiles_update ON public.annual_report_profiles
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_profiles.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_profiles.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY annual_report_profiles_delete ON public.annual_report_profiles
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_profiles.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );

CREATE TRIGGER annual_report_profiles_updated_at
  BEFORE UPDATE ON public.annual_report_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_annual_report_profiles
  AFTER INSERT OR UPDATE OR DELETE ON public.annual_report_profiles
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN long_term_debt_over_five_years_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN securities_pledged_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN contingent_liabilities_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN parent_company_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN agm_disposition_outcome text CHECK (
    agm_disposition_outcome IN ('proposal_approved', 'alternative_decision')
  ),
  ADD COLUMN agm_disposition_decision text CHECK (
    agm_disposition_decision IS NULL OR length(agm_disposition_decision) <= 2000
  ),
  ADD COLUMN proposed_dividend numeric(15, 2) CHECK (
    proposed_dividend IS NULL OR proposed_dividend >= 0
  ),
  ADD CONSTRAINT arsredovisning_narratives_agm_decision_consistency CHECK (
    agm_disposition_outcome IS DISTINCT FROM 'alternative_decision'
    OR nullif(trim(agm_disposition_decision), '') IS NOT NULL
  );

CREATE TABLE public.annual_report_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  version_number        integer NOT NULL CHECK (version_number > 0),
  schema_version        text NOT NULL,
  framework             text NOT NULL CHECK (framework IN ('k2', 'k3')),
  status                text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'ready_for_signature', 'signed', 'filed', 'registered', 'superseded')
  ),
  report_data           jsonb NOT NULL,
  ixbrl_data            jsonb,
  content_hash          text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  taxonomy_version      text,
  entry_point           text,
  validation_summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_version_id uuid REFERENCES public.annual_report_versions(id),
  finalized_at          timestamptz,
  finalized_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT annual_report_versions_number_unique UNIQUE (company_id, fiscal_period_id, version_number),
  CONSTRAINT annual_report_versions_content_unique UNIQUE (company_id, fiscal_period_id, content_hash),
  CONSTRAINT annual_report_versions_finalized_consistency CHECK (
    (status = 'draft' AND finalized_at IS NULL)
    OR (status <> 'draft' AND finalized_at IS NOT NULL)
  )
);

CREATE INDEX idx_annual_report_versions_period
  ON public.annual_report_versions (company_id, fiscal_period_id, version_number DESC);
CREATE INDEX idx_annual_report_versions_status
  ON public.annual_report_versions (company_id, status);

ALTER TABLE public.annual_report_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY annual_report_versions_select ON public.annual_report_versions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY annual_report_versions_insert ON public.annual_report_versions
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_versions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
    AND (user_id IS NULL OR user_id = auth.uid())
    AND status = 'draft'
    AND finalized_at IS NULL
    AND finalized_by IS NULL
  );
CREATE POLICY annual_report_versions_update ON public.annual_report_versions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_versions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_versions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
    AND status IN ('signed', 'filed')
  );
CREATE POLICY annual_report_versions_no_delete ON public.annual_report_versions
  FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION public.enforce_annual_report_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.framework IS DISTINCT FROM OLD.framework
     OR NEW.report_data IS DISTINCT FROM OLD.report_data
     OR NEW.ixbrl_data IS DISTINCT FROM OLD.ixbrl_data
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.taxonomy_version IS DISTINCT FROM OLD.taxonomy_version
     OR NEW.entry_point IS DISTINCT FROM OLD.entry_point
     OR NEW.validation_summary IS DISTINCT FROM OLD.validation_summary
     OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Annual report version content is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('ready_for_signature', 'superseded'))
    OR (OLD.status = 'ready_for_signature' AND NEW.status IN ('signed', 'superseded'))
    OR (OLD.status = 'signed' AND NEW.status IN ('filed', 'superseded'))
    OR (OLD.status = 'filed' AND NEW.status IN ('registered', 'superseded'))
  ) THEN
    RAISE EXCEPTION 'Invalid annual report version status transition: % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'signed' AND OLD.status IS DISTINCT FROM 'signed' AND (
    NOT EXISTS (
      SELECT 1
      FROM public.arsredovisning_signature_requests request
      WHERE request.annual_report_version_id = NEW.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.arsredovisning_signature_requests request
      WHERE request.annual_report_version_id = NEW.id
        AND request.status <> 'signed'
    )
  ) THEN
    RAISE EXCEPTION 'Annual report version cannot be signed before every locked signer has signed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'filed' AND OLD.status IS DISTINCT FROM 'filed' AND NOT EXISTS (
    SELECT 1
    FROM public.arsredovisning_submissions submission
    WHERE submission.annual_report_version_id = NEW.id
      AND submission.archive_status = 'stored'
      AND submission.uploaded_at IS NOT NULL
      AND submission.idnummer IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Annual report version cannot be filed without an archived Bolagsverket upload receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'registered' AND OLD.status IS DISTINCT FROM 'registered' AND NOT EXISTS (
    SELECT 1
    FROM public.arsredovisning_submissions submission
    WHERE submission.annual_report_version_id = NEW.id
      AND submission.status = 'registrerad'
  ) THEN
    RAISE EXCEPTION 'Annual report version cannot be registered without a registered Bolagsverket submission'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'Finalization metadata is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.finalized_by IS NOT NULL AND NEW.finalized_by IS DISTINCT FROM OLD.finalized_by THEN
    RAISE EXCEPTION 'Finalization metadata is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_annual_report_version_immutability
  BEFORE UPDATE ON public.annual_report_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_version_immutability();

CREATE OR REPLACE FUNCTION public.block_annual_report_version_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Annual report versions are retained as immutable accounting information (id=%)', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER block_annual_report_version_deletion
  BEFORE DELETE ON public.annual_report_versions
  FOR EACH ROW EXECUTE FUNCTION public.block_annual_report_version_deletion();

CREATE TRIGGER audit_annual_report_versions
  AFTER INSERT OR UPDATE OR DELETE ON public.annual_report_versions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TABLE public.annual_report_validation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  fiscal_period_id  uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  version_id        uuid NOT NULL REFERENCES public.annual_report_versions(id) ON DELETE RESTRICT,
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  validation_layer  text NOT NULL CHECK (validation_layer IN ('local', 'arelle', 'bolagsverket')),
  status            text NOT NULL CHECK (status IN ('passed', 'warnings', 'failed', 'unavailable')),
  validator_version text,
  artifact_hash     text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[a-f0-9]{64}$'),
  issues            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_annual_report_validation_runs_version
  ON public.annual_report_validation_runs (company_id, version_id, created_at DESC);

ALTER TABLE public.annual_report_validation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY annual_report_validation_runs_select ON public.annual_report_validation_runs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY annual_report_validation_runs_insert ON public.annual_report_validation_runs
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = annual_report_validation_runs.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
    AND (user_id IS NULL OR user_id = auth.uid())
  );
CREATE POLICY annual_report_validation_runs_no_update ON public.annual_report_validation_runs
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY annual_report_validation_runs_no_delete ON public.annual_report_validation_runs
  FOR DELETE USING (false);

CREATE TRIGGER audit_annual_report_validation_runs
  AFTER INSERT OR UPDATE OR DELETE ON public.annual_report_validation_runs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE OR REPLACE FUNCTION public.validate_annual_report_company_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_version_company uuid;
  linked_version_period uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.fiscal_periods fp
    WHERE fp.id = NEW.fiscal_period_id
      AND fp.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Fiscal period does not belong to annual report company'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_TABLE_NAME = 'annual_report_validation_runs' THEN
    SELECT company_id, fiscal_period_id
    INTO linked_version_company, linked_version_period
    FROM public.annual_report_versions
    WHERE id = NEW.version_id;
    IF linked_version_company IS DISTINCT FROM NEW.company_id
       OR linked_version_period IS DISTINCT FROM NEW.fiscal_period_id THEN
      RAISE EXCEPTION 'Annual report validation version belongs to another company or period'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'annual_report_versions' THEN
    IF NEW.supersedes_version_id IS NOT NULL THEN
      SELECT company_id, fiscal_period_id
      INTO linked_version_company, linked_version_period
      FROM public.annual_report_versions
      WHERE id = NEW.supersedes_version_id;
      IF linked_version_company IS DISTINCT FROM NEW.company_id
         OR linked_version_period IS DISTINCT FROM NEW.fiscal_period_id THEN
        RAISE EXCEPTION 'Superseded annual report version belongs to another company or period'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME IN ('arsredovisning_signature_requests', 'arsredovisning_submissions') THEN
    IF NEW.annual_report_version_id IS NOT NULL THEN
      SELECT company_id, fiscal_period_id
      INTO linked_version_company, linked_version_period
      FROM public.annual_report_versions
      WHERE id = NEW.annual_report_version_id;
      IF linked_version_company IS DISTINCT FROM NEW.company_id
         OR linked_version_period IS DISTINCT FROM NEW.fiscal_period_id THEN
        RAISE EXCEPTION 'Linked annual report version belongs to another company or period'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_annual_report_profiles_company_links
  BEFORE INSERT OR UPDATE ON public.annual_report_profiles
  FOR EACH ROW EXECUTE FUNCTION public.validate_annual_report_company_links();

CREATE TRIGGER validate_annual_report_versions_company_links
  BEFORE INSERT OR UPDATE ON public.annual_report_versions
  FOR EACH ROW EXECUTE FUNCTION public.validate_annual_report_company_links();

CREATE TRIGGER validate_annual_report_validation_company_links
  BEFORE INSERT OR UPDATE ON public.annual_report_validation_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_annual_report_company_links();

CREATE OR REPLACE FUNCTION public.create_annual_report_version(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_schema_version text,
  p_framework text,
  p_status text,
  p_report_data jsonb,
  p_ixbrl_data jsonb,
  p_content_hash text,
  p_taxonomy_version text,
  p_entry_point text,
  p_validation_summary jsonb,
  p_user_id uuid
)
RETURNS SETOF public.annual_report_versions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  existing_row public.annual_report_versions%ROWTYPE;
  next_version integer;
  previous_version_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Annual report version user must match authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status <> 'draft' THEN
    RAISE EXCEPTION 'Direct annual report version creation only permits draft status'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_fiscal_period_id::text, 0));

  SELECT * INTO existing_row
  FROM public.annual_report_versions
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND content_hash = p_content_hash;
  IF FOUND THEN
    RETURN NEXT existing_row;
    RETURN;
  END IF;

  SELECT version_number, id
  INTO next_version, previous_version_id
  FROM public.annual_report_versions
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
  ORDER BY version_number DESC
  LIMIT 1;
  next_version := coalesce(next_version, 0) + 1;

  INSERT INTO public.annual_report_versions (
    company_id,
    fiscal_period_id,
    user_id,
    version_number,
    schema_version,
    framework,
    status,
    report_data,
    ixbrl_data,
    content_hash,
    taxonomy_version,
    entry_point,
    validation_summary,
    supersedes_version_id,
    finalized_at,
    finalized_by
  ) VALUES (
    p_company_id,
    p_fiscal_period_id,
    p_user_id,
    next_version,
    p_schema_version,
    p_framework,
    p_status,
    p_report_data,
    p_ixbrl_data,
    p_content_hash,
    p_taxonomy_version,
    p_entry_point,
    p_validation_summary,
    previous_version_id,
    NULL,
    NULL
  )
  RETURNING * INTO existing_row;

  RETURN NEXT existing_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_annual_report_version(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_annual_report_version(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, jsonb, uuid
) TO authenticated, service_role;

ALTER TABLE public.arsredovisning_signature_requests
  ADD COLUMN annual_report_version_id uuid REFERENCES public.annual_report_versions(id) ON DELETE RESTRICT,
  ADD COLUMN signing_method text CHECK (
    signing_method IN ('paper_original', 'advanced_e_signature', 'bankid', 'bolagsverket')
  ),
  ADD COLUMN evidence_reference text CHECK (
    evidence_reference IS NULL OR length(evidence_reference) <= 500
  ),
  ADD COLUMN evidence_recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN evidence_recorded_at timestamptz,
  ADD CONSTRAINT arsredovisning_signature_evidence_consistency CHECK (
    status <> 'signed'
    OR annual_report_version_id IS NULL
    OR (
      signing_method IS NOT NULL
      AND evidence_recorded_at IS NOT NULL
      AND nullif(trim(evidence_reference), '') IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION public.invalidate_annual_report_signer_roster_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected_company_id uuid;
  affected_fiscal_period_id uuid;
  should_invalidate boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    should_invalidate := NEW.annual_report_version_id IS NULL;
    affected_company_id := NEW.company_id;
    affected_fiscal_period_id := NEW.fiscal_period_id;
  ELSIF TG_OP = 'DELETE' THEN
    should_invalidate := OLD.annual_report_version_id IS NULL;
    affected_company_id := OLD.company_id;
    affected_fiscal_period_id := OLD.fiscal_period_id;
  ELSE
    should_invalidate := OLD.annual_report_version_id IS NULL
      AND NEW.annual_report_version_id IS NULL
      AND (
        NEW.role IS DISTINCT FROM OLD.role
        OR NEW.signer_name IS DISTINCT FROM OLD.signer_name
        OR NEW.status IS DISTINCT FROM OLD.status
      );
    affected_company_id := NEW.company_id;
    affected_fiscal_period_id := NEW.fiscal_period_id;
  END IF;

  IF should_invalidate THEN
    UPDATE public.annual_report_profiles
    SET signer_roster_confirmed_at = NULL
    WHERE company_id = affected_company_id
      AND fiscal_period_id = affected_fiscal_period_id
      AND signer_roster_confirmed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER invalidate_annual_report_signer_roster_confirmation
  AFTER INSERT OR UPDATE OR DELETE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_annual_report_signer_roster_confirmation();

CREATE OR REPLACE FUNCTION public.prepare_annual_report_signature_slots(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_annual_report_version_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  bound_slot_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Annual report signature user must match authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.annual_report_versions
    WHERE id = p_annual_report_version_id
      AND company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND status = 'ready_for_signature'
  ) THEN
    RAISE EXCEPTION 'Annual report version is not ready for signatures'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.arsredovisning_signature_requests
  SET annual_report_version_id = p_annual_report_version_id
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'pending'
    AND annual_report_version_id IS NULL;
  GET DIAGNOSTICS bound_slot_count = ROW_COUNT;

  IF bound_slot_count = 0 THEN
    INSERT INTO public.arsredovisning_signature_requests (
      user_id,
      company_id,
      fiscal_period_id,
      annual_report_version_id,
      role,
      signer_name,
      status
    )
    SELECT
      p_user_id,
      p_company_id,
      p_fiscal_period_id,
      p_annual_report_version_id,
      roster.role,
      roster.signer_name,
      'pending'
    FROM (
      SELECT DISTINCT ON (lower(trim(request.role)), lower(trim(request.signer_name)))
        request.role,
        request.signer_name
      FROM public.arsredovisning_signature_requests request
      JOIN public.annual_report_versions prior_version
        ON prior_version.id = request.annual_report_version_id
      WHERE prior_version.company_id = p_company_id
        AND prior_version.fiscal_period_id = p_fiscal_period_id
        AND prior_version.id <> p_annual_report_version_id
        AND prior_version.version_number = (
          SELECT max(candidate.version_number)
          FROM public.annual_report_versions candidate
          WHERE candidate.company_id = p_company_id
            AND candidate.fiscal_period_id = p_fiscal_period_id
            AND candidate.id <> p_annual_report_version_id
            AND EXISTS (
              SELECT 1
              FROM public.arsredovisning_signature_requests candidate_request
              WHERE candidate_request.annual_report_version_id = candidate.id
            )
        )
      ORDER BY
        lower(trim(request.role)),
        lower(trim(request.signer_name)),
        request.created_at DESC
    ) AS roster;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_annual_report_signature_slots(
  uuid, uuid, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_annual_report_signature_slots(
  uuid, uuid, uuid, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_annual_report_version_with_signatures(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_schema_version text,
  p_framework text,
  p_status text,
  p_report_data jsonb,
  p_ixbrl_data jsonb,
  p_content_hash text,
  p_taxonomy_version text,
  p_entry_point text,
  p_validation_summary jsonb,
  p_user_id uuid
)
RETURNS SETOF public.annual_report_versions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  version_row public.annual_report_versions%ROWTYPE;
  live_roster_confirmation timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Final annual report versions may only be created by the trusted application service'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status <> 'ready_for_signature' THEN
    RAISE EXCEPTION 'Signature-bound annual report creation requires ready_for_signature status'
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(p_report_data) IS DISTINCT FROM 'object'
     OR p_report_data #>> '{fiscal_period,id}' IS DISTINCT FROM p_fiscal_period_id::text
     OR p_report_data ->> 'accounting_framework' IS DISTINCT FROM p_framework THEN
    RAISE EXCEPTION 'Annual report payload does not match its company framework or fiscal period'
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_validation_summary) IS DISTINCT FROM 'object'
     OR p_validation_summary -> 'ok' IS DISTINCT FROM 'true'::jsonb
     OR p_validation_summary -> 'error_count' IS DISTINCT FROM '0'::jsonb
     OR p_validation_summary ->> 'stage' IS DISTINCT FROM 'signing'
     OR jsonb_typeof(p_validation_summary -> 'profile') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_validation_summary -> 'disclosures') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_validation_summary -> 'eligibility') IS DISTINCT FROM 'object'
     OR p_validation_summary #>> '{profile,company_id}' IS DISTINCT FROM p_company_id::text
     OR p_validation_summary #>> '{profile,fiscal_period_id}' IS DISTINCT FROM p_fiscal_period_id::text THEN
    RAISE EXCEPTION 'Annual report finalization requires a complete server validation snapshot'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT signer_roster_confirmed_at
  INTO live_roster_confirmation
  FROM public.annual_report_profiles
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id;
  IF live_roster_confirmation IS NULL
     OR (p_validation_summary #>> '{profile,signer_roster_confirmed_at}')::timestamptz
        IS DISTINCT FROM live_roster_confirmation THEN
    RAISE EXCEPTION 'Annual report signer roster must be confirmed against the current company representatives'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO version_row
  FROM public.create_annual_report_version(
    p_company_id,
    p_fiscal_period_id,
    p_schema_version,
    p_framework,
    'draft',
    p_report_data,
    p_ixbrl_data,
    p_content_hash,
    p_taxonomy_version,
    p_entry_point,
    p_validation_summary,
    p_user_id
  );

  IF version_row.status = 'draft' THEN
    UPDATE public.annual_report_versions
    SET status = 'ready_for_signature',
        finalized_at = now(),
        finalized_by = p_user_id
    WHERE id = version_row.id
    RETURNING * INTO version_row;

    UPDATE public.annual_report_versions
    SET status = 'superseded'
    WHERE id = version_row.supersedes_version_id
      AND status IN ('ready_for_signature', 'signed');
  END IF;

  IF version_row.status = 'ready_for_signature' THEN
    PERFORM public.prepare_annual_report_signature_slots(
      p_company_id,
      p_fiscal_period_id,
      version_row.id,
      p_user_id
    );
    IF NOT EXISTS (
      SELECT 1
      FROM public.arsredovisning_signature_requests
      WHERE annual_report_version_id = version_row.id
    ) THEN
      RAISE EXCEPTION 'Annual report version requires at least one signer slot'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEXT version_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_annual_report_version_with_signatures(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, jsonb, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_annual_report_version_with_signatures(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text, text, jsonb, uuid
) TO service_role;

CREATE INDEX idx_arsredovisning_sigreq_version
  ON public.arsredovisning_signature_requests (company_id, annual_report_version_id);
WITH duplicate_roster_slots AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, fiscal_period_id, lower(trim(role)), lower(trim(signer_name))
      ORDER BY created_at, id
    ) AS duplicate_number
  FROM public.arsredovisning_signature_requests
  WHERE annual_report_version_id IS NULL AND status = 'pending'
)
DELETE FROM public.arsredovisning_signature_requests request
USING duplicate_roster_slots duplicate
WHERE request.id = duplicate.id
  AND duplicate.duplicate_number > 1;
CREATE UNIQUE INDEX uq_arsredovisning_sigreq_unbound_roster
  ON public.arsredovisning_signature_requests (
    company_id,
    fiscal_period_id,
    (lower(trim(role))),
    (lower(trim(signer_name)))
  )
  WHERE annual_report_version_id IS NULL AND status = 'pending';

CREATE TRIGGER validate_arsredovisning_signature_version_links
  BEFORE INSERT OR UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_annual_report_company_links();

CREATE TRIGGER audit_arsredovisning_signature_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE OR REPLACE FUNCTION public.serialize_annual_report_signature_signing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'signed'
     AND OLD.status IS DISTINCT FROM 'signed'
     AND NEW.annual_report_version_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW.annual_report_version_id::text, 0)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER serialize_annual_report_signature_signing
  BEFORE UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.serialize_annual_report_signature_signing();

CREATE OR REPLACE FUNCTION public.complete_annual_report_version_signing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'signed'
     AND OLD.status IS DISTINCT FROM 'signed'
     AND NEW.annual_report_version_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.arsredovisning_signature_requests pending_signature
       WHERE pending_signature.annual_report_version_id = NEW.annual_report_version_id
         AND pending_signature.status <> 'signed'
     ) THEN
    UPDATE public.annual_report_versions
    SET status = 'signed'
    WHERE id = NEW.annual_report_version_id
      AND company_id = NEW.company_id
      AND fiscal_period_id = NEW.fiscal_period_id
      AND status = 'ready_for_signature';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER complete_annual_report_version_signing
  AFTER UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.complete_annual_report_version_signing();

CREATE OR REPLACE FUNCTION public.enforce_signed_signature_request_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'Cannot modify a signed signature request (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'declined' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'Cannot modify a declined signature request (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE public.arsredovisning_submissions
SET handling_typ = 'arsredovisning_komplett'
WHERE handling_typ = 'arsredovisning';

ALTER TABLE public.arsredovisning_submissions
  DROP CONSTRAINT IF EXISTS arsredovisning_submissions_handling_typ_check,
  DROP CONSTRAINT IF EXISTS arsredovisning_submissions_status_check;

ALTER TABLE public.arsredovisning_submissions
  ADD CONSTRAINT arsredovisning_submissions_handling_typ_check CHECK (
    handling_typ IN ('arsredovisning_komplett', 'arsredovisning_kompletteras', 'revisionsberattelse')
  ),
  ADD CONSTRAINT arsredovisning_submissions_status_check CHECK (
    status IN (
      'draft', 'kontrollerad', 'sending', 'uploaded', 'unknown', 'inkommen',
      'forelagd', 'komplettering', 'registrerad', 'avslutad', 'error'
    )
  ),
  ADD COLUMN annual_report_version_id uuid REFERENCES public.annual_report_versions(id) ON DELETE RESTRICT,
  ADD COLUMN request_key text,
  ADD COLUMN archive_status text NOT NULL DEFAULT 'pending' CHECK (
    archive_status IN ('pending', 'stored', 'failed')
  ),
  ADD COLUMN upload_started_at timestamptz,
  ADD COLUMN external_receipt jsonb;

CREATE UNIQUE INDEX uq_arsredovisning_submissions_request_key
  ON public.arsredovisning_submissions (company_id, environment, request_key)
  WHERE request_key IS NOT NULL;

CREATE UNIQUE INDEX uq_arsredovisning_submissions_remote_id
  ON public.arsredovisning_submissions (environment, idnummer)
  WHERE idnummer IS NOT NULL;

CREATE TRIGGER validate_arsredovisning_submission_version_links
  BEFORE INSERT OR UPDATE ON public.arsredovisning_submissions
  FOR EACH ROW EXECUTE FUNCTION public.validate_annual_report_company_links();

CREATE OR REPLACE FUNCTION public.enforce_arsred_submission_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.uploaded_at IS NOT NULL OR OLD.status IN ('sending', 'unknown', 'uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad') THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.annual_report_version_id IS DISTINCT FROM OLD.annual_report_version_id
       OR NEW.handling_typ IS DISTINCT FROM OLD.handling_typ
       OR NEW.taxonomy_version IS DISTINCT FROM OLD.taxonomy_version
       OR NEW.entry_point IS DISTINCT FROM OLD.entry_point
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.request_key IS DISTINCT FROM OLD.request_key
       OR (OLD.idnummer IS NOT NULL AND NEW.idnummer IS DISTINCT FROM OLD.idnummer)
       OR (OLD.sha256_checksumma IS NOT NULL AND NEW.sha256_checksumma IS DISTINCT FROM OLD.sha256_checksumma)
       OR NEW.kontrollsumma IS DISTINCT FROM OLD.kontrollsumma
       OR NEW.dokument_id IS DISTINCT FROM OLD.dokument_id
       OR NEW.archive_status IS DISTINCT FROM OLD.archive_status
       OR NEW.undertecknare_pnr_hash IS DISTINCT FROM OLD.undertecknare_pnr_hash
       OR NEW.avsandare_pnr_hash IS DISTINCT FROM OLD.avsandare_pnr_hash
       OR NEW.upload_started_at IS DISTINCT FROM OLD.upload_started_at
       OR (OLD.bolagsverket_url IS NOT NULL AND NEW.bolagsverket_url IS DISTINCT FROM OLD.bolagsverket_url)
       OR (OLD.external_receipt IS NOT NULL AND NEW.external_receipt IS DISTINCT FROM OLD.external_receipt)
       OR (OLD.uploaded_at IS NOT NULL AND NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at) THEN
      RAISE EXCEPTION 'Inlämnad årsredovisning kan inte ändras (submission %)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('kontrollerad', 'error'))
    OR (OLD.status = 'kontrollerad' AND NEW.status IN ('kontrollerad', 'sending', 'error', 'draft'))
    OR (OLD.status = 'sending' AND NEW.status IN ('uploaded', 'unknown'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad'))
    OR (OLD.status = 'uploaded' AND NEW.status IN ('inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad', 'error'))
    OR (OLD.status = 'inkommen' AND NEW.status IN ('forelagd', 'komplettering', 'registrerad', 'avslutad'))
    OR (OLD.status = 'forelagd' AND NEW.status IN ('komplettering', 'registrerad', 'avslutad'))
    OR (OLD.status = 'komplettering' AND NEW.status IN ('forelagd', 'registrerad', 'avslutad'))
    OR (OLD.status = 'error' AND NEW.status IN ('draft', 'kontrollerad'))
  ) THEN
    RAISE EXCEPTION 'Ogiltig statusövergång för årsredovisningsinlämning: % till %', OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "arsredovisning_sigreq_insert"
  ON public.arsredovisning_signature_requests;
DROP POLICY IF EXISTS "arsredovisning_sigreq_update"
  ON public.arsredovisning_signature_requests;
DROP POLICY IF EXISTS "arsredovisning_sigreq_delete"
  ON public.arsredovisning_signature_requests;

CREATE POLICY "arsredovisning_sigreq_insert"
  ON public.arsredovisning_signature_requests FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_signature_requests.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "arsredovisning_sigreq_update"
  ON public.arsredovisning_signature_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_signature_requests.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_signature_requests.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "arsredovisning_sigreq_delete"
  ON public.arsredovisning_signature_requests FOR DELETE
  USING (
    status = 'pending'
    AND annual_report_version_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_signature_requests.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "insert own-company arsredovisning submissions"
  ON public.arsredovisning_submissions;
DROP POLICY IF EXISTS "update own-company arsredovisning submissions"
  ON public.arsredovisning_submissions;

CREATE POLICY "insert own-company arsredovisning submissions"
  ON public.arsredovisning_submissions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_submissions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "update own-company arsredovisning submissions"
  ON public.arsredovisning_submissions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_submissions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = arsredovisning_submissions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "insert own-company avtal acceptances"
  ON public.bolagsverket_avtal_acceptances;
CREATE POLICY "insert own-company avtal acceptances"
  ON public.bolagsverket_avtal_acceptances FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = bolagsverket_avtal_acceptances.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "insert own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions;
DROP POLICY IF EXISTS "update own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions;
DROP POLICY IF EXISTS "delete own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions;

CREATE POLICY "insert own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = bolagsverket_subscriptions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "update own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = bolagsverket_subscriptions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = bolagsverket_subscriptions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );
CREATE POLICY "delete own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_members.company_id = bolagsverket_subscriptions.company_id
        AND company_members.user_id = auth.uid()
        AND company_members.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';
