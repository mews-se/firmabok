-- =============================================================================
-- Salary: optional vacation accrual ("none" mode)
-- =============================================================================
-- Adds a third value to employees.vacation_rule so a company can disable
-- semesteravsättning entirely. Useful for sole owners (ägare = enda anställd)
-- who don't accrue semester — booking otherwise creates a phantom 2920 liability.
--
-- procentregeln    — 12% (or 14.4% for 30+ days) accrued to 2920 (Semesterlagen 26§)
-- sammaloneregeln  — semestertillägg only (Semesterlagen 16a§)
-- none             — no accrual; salary expense is the full cost

ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_vacation_rule_check;

ALTER TABLE public.employees ADD CONSTRAINT employees_vacation_rule_check
  CHECK (vacation_rule IN ('procentregeln', 'sammaloneregeln', 'none'));

NOTIFY pgrst, 'reload schema';
