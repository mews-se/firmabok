-- Migration: salary_worked_days — per-day worked hours for hourly employees
--
-- Why this exists: hourly employees (timanställd) need per-day hour tracking
-- so payroll can derive base salary as `hourly_rate × Σ hours`. The previous
-- model relied on a single nullable `salary_run_employees.hours_worked`
-- column, but had no UI to set it after the employee was added to a run.
--
-- Mirrors salary_absence_days deliberately: same calendar UX, same RLS shape,
-- same per-day granularity. Worked time and absence time are separate domain
-- concepts (presence vs frånvaro) so they live in separate tables — combining
-- them via an enum would pollute every absence-side query (AGI Frånvarouppgift,
-- högriskskydd lookups, sjuklöneperiod derivation).
--
-- Half-day mixing is allowed: an employee can have 4h worked + 4h sick on the
-- same date. The 24-hour cap across both tables is enforced by the trigger
-- introduced in 20260512120100_worked_days_absence_conflict_trigger.sql.

CREATE TABLE public.salary_worked_days (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id             UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Optional link to the pay run that already absorbed this day. Null while
  -- the user marks worked days before a run exists, or for periods not yet
  -- materialized into a salary run.
  salary_run_employee_id  UUID REFERENCES salary_run_employees(id) ON DELETE SET NULL,
  work_date               DATE NOT NULL,
  -- Hours worked on this date. Defaults to 8.0 for a full scheduled day.
  -- Allows partial days (e.g. 4h morning shift) and overtime above a normal
  -- workday (up to 24h hard cap; combined with absence the trigger enforces
  -- the same 24h limit across both tables).
  hours                   NUMERIC(5, 2) NOT NULL DEFAULT 8.0
                            CHECK (hours > 0 AND hours <= 24),
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per employee per date. Unlike absence (which allows multiple types
-- on the same date, e.g. half-day VAB + half-day other), worked time is a
-- single hours value — re-marking a day overwrites the existing row.
CREATE UNIQUE INDEX idx_salary_worked_days_unique
  ON public.salary_worked_days (employee_id, work_date);

-- Range queries by employee+date are the dominant access pattern: pay-period
-- aggregation when the calculator sums hours for hourly employees.
CREATE INDEX idx_salary_worked_days_employee_date
  ON public.salary_worked_days (employee_id, work_date);

-- Lookup by run, used when the calculator materializes line items.
CREATE INDEX idx_salary_worked_days_run
  ON public.salary_worked_days (salary_run_employee_id)
  WHERE salary_run_employee_id IS NOT NULL;

-- Company-level scans.
CREATE INDEX idx_salary_worked_days_company_date
  ON public.salary_worked_days (company_id, work_date);

ALTER TABLE public.salary_worked_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_worked_days_select" ON public.salary_worked_days
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_worked_days_insert" ON public.salary_worked_days
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_worked_days_update" ON public.salary_worked_days
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_worked_days_delete" ON public.salary_worked_days
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER salary_worked_days_updated_at
  BEFORE UPDATE ON public.salary_worked_days
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
