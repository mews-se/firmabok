-- =============================================================================
-- Employee benefits (förmånshantering)
-- =============================================================================
-- Per-employee benefit assignments that drive auto-generated line items on
-- every salary run. Today the engine has helpers for car/meal/wellness benefits
-- but no link from a specific employee to a specific benefit instance — meaning
-- users had to add a benefit_* line item manually each month. This table closes
-- that gap.
--
-- Includes bike benefit (cykelförmån, skattefri schablon 3 000 kr/år from 2022,
-- Skatteverket).

CREATE TABLE public.employee_benefits (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  benefit_type    text NOT NULL
    CHECK (benefit_type IN ('bike', 'car', 'meals', 'housing', 'wellness', 'other')),
  description     text NOT NULL,

  -- Monthly taxable förmånsvärde (SEK). For bike, computed as
  -- max(0, annual_market_value - 3000) / 12 per Skatteverket schablon.
  monthly_value   numeric NOT NULL CHECK (monthly_value >= 0),

  valid_from      date NOT NULL,
  valid_to        date,

  -- Free-form context: bike → { annual_market_value, tax_free_allowance }
  --                    car  → { nybilspris, environmental_type, ... }
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  is_active       boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

ALTER TABLE public.employee_benefits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_benefits_select" ON public.employee_benefits
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employee_benefits_insert" ON public.employee_benefits
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employee_benefits_update" ON public.employee_benefits
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employee_benefits_delete" ON public.employee_benefits
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_employee_benefits_employee ON public.employee_benefits (employee_id);
CREATE INDEX idx_employee_benefits_company ON public.employee_benefits (company_id);
CREATE INDEX idx_employee_benefits_active
  ON public.employee_benefits (employee_id, valid_from, valid_to)
  WHERE is_active = true;

CREATE TRIGGER employee_benefits_updated_at
  BEFORE UPDATE ON public.employee_benefits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Link a salary_line_items row back to the employee_benefits row that produced
-- it. Used by the calculate flow to delete-then-recreate benefit line items
-- without disturbing manually-added line items.
ALTER TABLE public.salary_line_items
  ADD COLUMN source_benefit_id uuid REFERENCES public.employee_benefits(id) ON DELETE SET NULL;

CREATE INDEX idx_salary_line_items_source_benefit
  ON public.salary_line_items (source_benefit_id)
  WHERE source_benefit_id IS NOT NULL;

-- Extend salary_line_items to accept a benefit_bike type for cykelförmån.
ALTER TABLE public.salary_line_items DROP CONSTRAINT IF EXISTS salary_line_items_item_type_check;
ALTER TABLE public.salary_line_items ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary', 'overtime', 'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness',
    'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'vacation',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'net_deduction_advance', 'net_deduction_union', 'net_deduction_benefit_payment',
    'net_deduction_other',
    'correction', 'other'
  ));

NOTIFY pgrst, 'reload schema';
