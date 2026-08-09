-- Exact kvarskatt deadlines and persisted post-company onboarding state.
--
-- Kvarskatt is not calculated from a guessed 90-day offset. Skatteverket
-- states that the exact payment due date is printed on the final tax notice,
-- and reassessment decisions can have a materially shorter payment window.
-- Store the notice date and its exact due date, then let the deadline
-- generator mirror that date without banking-day adjustment.
--
-- Oasis onboarding state belongs to the company, not localStorage. Existing
-- onboarded companies are backfilled as completed and dismissed so only newly
-- created companies see the new optional setup surface.

-- =============================================================================
-- 1. Persisted initial setup state
-- =============================================================================
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS initial_setup_path text NULL,
  ADD COLUMN IF NOT EXISTS initial_setup_completed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS initial_setup_dismissed_at timestamptz NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_initial_setup_path_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_initial_setup_path_check
  CHECK (initial_setup_path IS NULL OR initial_setup_path IN ('migration', 'bank', 'fresh'));

UPDATE public.company_settings
SET initial_setup_completed_at = COALESCE(initial_setup_completed_at, now()),
    initial_setup_dismissed_at = COALESCE(initial_setup_dismissed_at, now())
WHERE onboarding_complete = true
  AND initial_setup_completed_at IS NULL;

COMMENT ON COLUMN public.company_settings.initial_setup_path IS
  'Optional first-value path selected after company creation: migration, bank, or fresh.';
COMMENT ON COLUMN public.company_settings.initial_setup_completed_at IS
  'When the selected first-value setup path was completed.';
COMMENT ON COLUMN public.company_settings.initial_setup_dismissed_at IS
  'When the optional dashboard setup checklist was dismissed.';

-- =============================================================================
-- 2. Final tax notices and reassessment decisions
-- =============================================================================
CREATE TABLE public.tax_assessment_notices (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  decision_type    text NOT NULL CHECK (decision_type IN ('final', 'reassessment')),
  decision_date    date NOT NULL,
  payment_due_date date NOT NULL,
  archived_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_assessment_notices_due_after_decision
    CHECK (payment_due_date >= decision_date),
  CONSTRAINT tax_assessment_notices_company_period_type_key
    UNIQUE (company_id, fiscal_period_id, decision_type)
);

ALTER TABLE public.tax_assessment_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company tax_assessment_notices"
  ON public.tax_assessment_notices FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company tax_assessment_notices"
  ON public.tax_assessment_notices FOR INSERT
  WITH CHECK (
    company_id IN (SELECT user_company_ids())
    AND user_id = auth.uid()
  );
CREATE POLICY "update own-company tax_assessment_notices"
  ON public.tax_assessment_notices FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company tax_assessment_notices"
  ON public.tax_assessment_notices FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_tax_assessment_notices_company
  ON public.tax_assessment_notices (company_id);
CREATE INDEX idx_tax_assessment_notices_due
  ON public.tax_assessment_notices (company_id, payment_due_date)
  WHERE archived_at IS NULL;
CREATE INDEX idx_tax_assessment_notices_period
  ON public.tax_assessment_notices (fiscal_period_id);

CREATE TRIGGER set_updated_at_tax_assessment_notices
  BEFORE UPDATE ON public.tax_assessment_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_tax_assessment_notices
  AFTER INSERT OR UPDATE OR DELETE ON public.tax_assessment_notices
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Relational identity lets edits and archives reconcile the exact generated
-- deadline without encoding notice ids into user-facing titles.
ALTER TABLE public.deadlines
  ADD COLUMN IF NOT EXISTS tax_assessment_notice_id uuid NULL
    REFERENCES public.tax_assessment_notices(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_deadlines_tax_assessment_notice
  ON public.deadlines (tax_assessment_notice_id)
  WHERE tax_assessment_notice_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
