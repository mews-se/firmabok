-- Harden tax notice tenant integrity and preserve every reassessment decision.

-- A fiscal year can receive more than one reassessment decision. The decision
-- date is part of the notice identity so repeated POST requests stay
-- idempotent without overwriting an earlier decision.
ALTER TABLE public.tax_assessment_notices
  DROP CONSTRAINT tax_assessment_notices_company_period_type_key;

ALTER TABLE public.tax_assessment_notices
  ADD CONSTRAINT tax_assessment_notices_company_period_type_date_key
  UNIQUE (company_id, fiscal_period_id, decision_type, decision_date);

-- The creator is attribution, not ownership. Company records must survive a
-- user deletion, including when a generated deadline references the notice.
ALTER TABLE public.tax_assessment_notices
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.tax_assessment_notices
  DROP CONSTRAINT tax_assessment_notices_user_id_fkey;

ALTER TABLE public.tax_assessment_notices
  ADD CONSTRAINT tax_assessment_notices_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Company-owned foreign keys must agree on company_id. The additional unique
-- keys are safe because both referenced id columns are already primary keys.
ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_periods_id_company_id_key UNIQUE (id, company_id);

ALTER TABLE public.tax_assessment_notices
  DROP CONSTRAINT tax_assessment_notices_fiscal_period_id_fkey;

ALTER TABLE public.tax_assessment_notices
  ADD CONSTRAINT tax_assessment_notices_fiscal_period_company_fkey
  FOREIGN KEY (fiscal_period_id, company_id)
  REFERENCES public.fiscal_periods(id, company_id) ON DELETE RESTRICT;

ALTER TABLE public.tax_assessment_notices
  ADD CONSTRAINT tax_assessment_notices_id_company_id_key UNIQUE (id, company_id);

ALTER TABLE public.deadlines
  DROP CONSTRAINT deadlines_tax_assessment_notice_id_fkey;

ALTER TABLE public.deadlines
  ADD CONSTRAINT deadlines_tax_assessment_notice_company_fkey
  FOREIGN KEY (tax_assessment_notice_id, company_id)
  REFERENCES public.tax_assessment_notices(id, company_id) ON DELETE RESTRICT;

-- Keep creator attribution immutable for authenticated PostgREST callers.
CREATE OR REPLACE FUNCTION public.enforce_tax_assessment_notice_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Tax assessment notice attribution is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_tax_assessment_notice_attribution
  BEFORE UPDATE OF user_id ON public.tax_assessment_notices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_assessment_notice_attribution();

-- Reads follow the repository-wide membership model. Writes additionally
-- require the active company and a non-viewer role, matching other tenant
-- tables and preventing direct PostgREST writes from bypassing the API guard.
DROP POLICY "insert own-company tax_assessment_notices"
  ON public.tax_assessment_notices;
DROP POLICY "update own-company tax_assessment_notices"
  ON public.tax_assessment_notices;
DROP POLICY "delete own-company tax_assessment_notices"
  ON public.tax_assessment_notices;

CREATE POLICY tax_assessment_notices_insert
  ON public.tax_assessment_notices FOR INSERT TO public
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = auth.uid()
  );

CREATE POLICY tax_assessment_notices_update
  ON public.tax_assessment_notices FOR UPDATE TO public
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

CREATE POLICY tax_assessment_notices_delete
  ON public.tax_assessment_notices FOR DELETE TO public
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

NOTIFY pgrst, 'reload schema';
