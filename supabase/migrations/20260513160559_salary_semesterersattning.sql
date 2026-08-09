-- =============================================================================
-- Salary: semesterersättning (vacation compensation paid out directly)
-- =============================================================================
-- Adds a fourth vacation_rule mode: instead of accruing semesterlöneskuld
-- (BAS 2920), the employer pays 12% (or 14.4% for 30+ days) on top of every
-- paycheck as semesterersättning. Common for hourly/short-term workers where
-- tracking vacation days is overkill.
--
-- Also adds 'semesterersattning' to salary_line_items.item_type so the engine
-- can emit a derived line item that books to BAS 7285 Semesterlöner.
--
-- vacation_rule modes:
--   procentregeln      — 12%/14.4% accrued to 2920 (Semesterlagen 26§)
--   sammaloneregeln    — semestertillägg accrued to 2920 (Semesterlagen 16a§)
--   none               — no accrual; vacation cost assumed embedded in monthly salary
--   semesterersattning — 12%/14.4% paid out each cycle to 7285 (no accrual)

ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_vacation_rule_check;

ALTER TABLE public.employees ADD CONSTRAINT employees_vacation_rule_check
  CHECK (vacation_rule IN ('procentregeln', 'sammaloneregeln', 'none', 'semesterersattning'));

ALTER TABLE public.salary_line_items DROP CONSTRAINT IF EXISTS salary_line_items_item_type_check;
ALTER TABLE public.salary_line_items ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary', 'overtime', 'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness',
    'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'vacation', 'semesterersattning',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'net_deduction_advance', 'net_deduction_union', 'net_deduction_benefit_payment',
    'net_deduction_other',
    'correction', 'other'
  ));

NOTIFY pgrst, 'reload schema';
