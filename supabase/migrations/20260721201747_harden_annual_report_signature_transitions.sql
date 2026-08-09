-- Keep signer roster drafting available to authenticated company members, but
-- reserve legally significant signature transitions for the trusted service
-- role after the API has verified ownership, version state, and evidence.

DROP POLICY IF EXISTS "arsredovisning_sigreq_insert"
  ON public.arsredovisning_signature_requests;

CREATE POLICY "arsredovisning_sigreq_insert"
  ON public.arsredovisning_signature_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = (SELECT auth.uid())
    AND status = 'pending'
    AND annual_report_version_id IS NULL
    AND signing_method IS NULL
    AND evidence_reference IS NULL
    AND evidence_recorded_by IS NULL
    AND evidence_recorded_at IS NULL
    AND signed_at IS NULL
    AND bankid_signature_data IS NULL
    AND signer_personnummer_encrypted IS NULL
    AND signer_personnummer_hash IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.fiscal_periods fp
      WHERE fp.id = public.arsredovisning_signature_requests.fiscal_period_id
        AND fp.company_id = public.arsredovisning_signature_requests.company_id
    )
  );

-- Authenticated users may no longer transition or rewrite a signature row
-- directly through PostgREST. The service role bypasses RLS and is used only
-- after the API route has completed its ownership and state checks.
DROP POLICY IF EXISTS "arsredovisning_sigreq_update"
  ON public.arsredovisning_signature_requests;

DROP POLICY IF EXISTS "arsredovisning_sigreq_delete"
  ON public.arsredovisning_signature_requests;

CREATE POLICY "arsredovisning_sigreq_delete"
  ON public.arsredovisning_signature_requests
  FOR DELETE
  TO authenticated
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND status = 'pending'
    AND annual_report_version_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.fiscal_periods fp
      WHERE fp.id = public.arsredovisning_signature_requests.fiscal_period_id
        AND fp.company_id = public.arsredovisning_signature_requests.company_id
    )
  );

-- Existing signed evidence is retained unchanged. NOT VALID preserves those
-- immutable historical rows while enforcing the structured format for every
-- new or updated reference.
ALTER TABLE public.arsredovisning_signature_requests
  ADD CONSTRAINT arsredovisning_signature_evidence_reference_format
  CHECK (
    evidence_reference IS NULL
    OR evidence_reference ~ '^(archive|document|receipt):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$'
  ) NOT VALID;

COMMENT ON COLUMN public.arsredovisning_signature_requests.evidence_reference IS
  'Opaque reference only: archive:<id>, document:<id>, or receipt:<id>. Never store free text or personal data.';

CREATE OR REPLACE FUNCTION public.enforce_annual_report_signature_version_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  linked_version_status text;
  linked_version_finalized_date date;
BEGIN
  IF NEW.status <> 'signed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'signed' THEN
    RETURN NEW;
  END IF;

  SELECT
    version.status,
    (version.finalized_at AT TIME ZONE 'Europe/Stockholm')::date
  INTO linked_version_status, linked_version_finalized_date
  FROM public.annual_report_versions version
  WHERE version.id = NEW.annual_report_version_id;

  IF linked_version_status IS DISTINCT FROM 'ready_for_signature'
     OR linked_version_finalized_date IS NULL THEN
    RAISE EXCEPTION 'Annual report version is not ready for signature evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.signed_at AT TIME ZONE 'Europe/Stockholm')::date
       < linked_version_finalized_date
     OR (NEW.signed_at AT TIME ZONE 'Europe/Stockholm')::date
       > (now() AT TIME ZONE 'Europe/Stockholm')::date THEN
    RAISE EXCEPTION 'Signature date must be between version finalization and today'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_annual_report_signature_version_state
  BEFORE INSERT OR UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_annual_report_signature_version_state();

NOTIFY pgrst, 'reload schema';
