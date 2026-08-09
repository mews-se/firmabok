-- Salary payslip delivery log.
--
-- Per BFL 7 kap.: delivery confirmation of lönespecifikationer must be
-- retained as part of the audit trail. The send route currently calls Resend
-- and returns the count, but doesn't persist a per-employee record — so we
-- can't answer "did Anna receive her March payslip?" months later.
--
-- This table stores one row per (salary_run, employee, attempt) with the
-- Resend message_id (if known) so a follow-up webhook can update status to
-- delivered/bounced/complained.

CREATE TABLE IF NOT EXISTS public.salary_payslip_deliveries (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  salary_run_id         uuid NOT NULL REFERENCES public.salary_runs(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  email_address         text NOT NULL,
  status                text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped')),

  -- Resend (or other provider) tracking
  provider              text NOT NULL DEFAULT 'resend',
  provider_message_id   text,
  provider_event        jsonb,

  error_message         text,

  sent_at               timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  bounced_at            timestamptz,
  complained_at         timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_payslip_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_payslip_deliveries_select"
  ON public.salary_payslip_deliveries
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_payslip_deliveries_insert"
  ON public.salary_payslip_deliveries
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_payslip_deliveries_update"
  ON public.salary_payslip_deliveries
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));

-- No DELETE policy — BFL 7 kap. requires retention of delivery records.

CREATE INDEX idx_payslip_deliveries_run
  ON public.salary_payslip_deliveries (salary_run_id);

CREATE INDEX idx_payslip_deliveries_company
  ON public.salary_payslip_deliveries (company_id);

CREATE INDEX idx_payslip_deliveries_provider_msg
  ON public.salary_payslip_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER salary_payslip_deliveries_updated_at
  BEFORE UPDATE ON public.salary_payslip_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
