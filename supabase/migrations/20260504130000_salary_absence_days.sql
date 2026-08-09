-- Migration: salary_absence_days — per-day absence records for payroll
--
-- Why this exists: Swedish payroll law requires per-day absence tracking,
-- not aggregated day counts. Several rules collapse without dates:
--   * Karensavdrag is once per sjuklöneperiod (Sjuklönelagen). The period is
--     defined by contiguous sick days; you cannot determine "is this a new
--     period?" without dates.
--   * Återinsjuknande: if the employee falls sick again within 5 calendar
--     days, the same period continues — no new karensavdrag. Requires actual
--     dates, not counts.
--   * Allmänt högriskskydd caps karensavdrag at 10 per rolling 12-month
--     period — requires per-day timestamps across pay periods.
--   * Day 8 läkarintyg flag and day 14/15 transition to Försäkringskassan
--     are per-period boundaries.
--   * AGI 2025+ <Frånvarouppgift> reports parental leave as per-event date
--     records (forwarded to Försäkringskassan), not as day counts.
--
-- The previous model stored aggregated counts on salary_run_employees
-- (sick_days, vab_days, parental_days) summed from line_items.quantity.
-- Those columns remain as the materialized aggregate — they are now
-- *derived* from this table at calculation time, not user-entered.

CREATE TABLE public.salary_absence_days (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id             UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Optional link to the pay run that already absorbed this day. Null while
  -- the employee marks future absence before a run exists.
  salary_run_employee_id  UUID REFERENCES salary_run_employees(id) ON DELETE SET NULL,
  absence_date            DATE NOT NULL,
  -- 'sick' covers all sjukfrånvaro days; karens vs day-2-14 vs day-15+ are
  -- *derived* at calculation time from the date sequence and högriskskydd
  -- state. Storing them denormalizes and creates correctness risks if a user
  -- backfills an earlier sick day after the fact.
  absence_type            TEXT NOT NULL CHECK (absence_type IN (
    'sick',          -- sjukfrånvaro
    'vab',           -- vård av barn (tillfällig föräldrapenning)
    'parental',      -- föräldraledighet (föräldrapenning)
    'pregnancy',     -- graviditetspenning
    'care_relative', -- närståendepenning
    'study',         -- studieledig
    'other_leave'
  )),
  -- Hours absent on this date. Defaults to 8.0 for a full scheduled day.
  -- Allows partial-day VAB / sick (e.g. 4 hours for half-day pickup).
  hours                   NUMERIC(5, 2) NOT NULL DEFAULT 8.0
                            CHECK (hours > 0 AND hours <= 24),
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per employee+date+type. An employee can have both a sick day and
-- (rarely) another type on the same date, but not two of the same type.
CREATE UNIQUE INDEX idx_salary_absence_days_unique
  ON public.salary_absence_days (employee_id, absence_date, absence_type);

-- Range queries by employee+date are the dominant access pattern: pay-period
-- aggregation, återinsjuknande lookback, högriskskydd 12-month rolling cap.
CREATE INDEX idx_salary_absence_days_employee_date
  ON public.salary_absence_days (employee_id, absence_date);

-- Lookup by run, used when the calculator materializes line items.
CREATE INDEX idx_salary_absence_days_run
  ON public.salary_absence_days (salary_run_employee_id)
  WHERE salary_run_employee_id IS NOT NULL;

-- Company-level scans (e.g. AGI Frånvarouppgift section across all employees).
CREATE INDEX idx_salary_absence_days_company_date
  ON public.salary_absence_days (company_id, absence_date);

ALTER TABLE public.salary_absence_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_absence_days_select" ON public.salary_absence_days
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_absence_days_insert" ON public.salary_absence_days
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_absence_days_update" ON public.salary_absence_days
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "salary_absence_days_delete" ON public.salary_absence_days
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER salary_absence_days_updated_at
  BEFORE UPDATE ON public.salary_absence_days
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
