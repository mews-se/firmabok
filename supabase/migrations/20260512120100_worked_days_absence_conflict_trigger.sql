-- Migration: 24-hour cap across worked + absence days for the same employee+date
--
-- Half-day mixing is allowed: an employee can have 4h worked + 4h sick on the
-- same date. The legal/biological constraint is that a single calendar day
-- has 24 hours — combined worked + absence hours must not exceed that.
--
-- This is enforced as a trigger (not a CHECK constraint) because CHECK cannot
-- reference another table. Two BEFORE INSERT/UPDATE triggers, one on each
-- table, both call the shared function below. The function sums the OTHER
-- table's hours for the same (employee_id, date), adds NEW.hours, and raises
-- if the total exceeds 24.
--
-- For UPDATE on the same row, we exclude the row's own previous contribution
-- from the sum (otherwise editing 8h → 6h on a worked day with 8h absence
-- would falsely report 16+8 > 24). This is handled by the WHERE id <> NEW.id
-- on the same-table side.

CREATE OR REPLACE FUNCTION public.check_salary_day_hours_cap()
RETURNS TRIGGER AS $$
DECLARE
  v_employee_id  UUID;
  v_date         DATE;
  v_other_total  NUMERIC(6, 2);
  v_same_total   NUMERIC(6, 2);
  v_total        NUMERIC(6, 2);
BEGIN
  -- Resolve the (employee, date) pair from whichever table fired the trigger.
  IF TG_TABLE_NAME = 'salary_worked_days' THEN
    v_employee_id := NEW.employee_id;
    v_date        := NEW.work_date;

    SELECT COALESCE(SUM(hours), 0) INTO v_other_total
      FROM public.salary_absence_days
     WHERE employee_id = v_employee_id
       AND absence_date = v_date;

    SELECT COALESCE(SUM(hours), 0) INTO v_same_total
      FROM public.salary_worked_days
     WHERE employee_id = v_employee_id
       AND work_date   = v_date
       AND id <> NEW.id;

  ELSIF TG_TABLE_NAME = 'salary_absence_days' THEN
    v_employee_id := NEW.employee_id;
    v_date        := NEW.absence_date;

    SELECT COALESCE(SUM(hours), 0) INTO v_other_total
      FROM public.salary_worked_days
     WHERE employee_id = v_employee_id
       AND work_date   = v_date;

    SELECT COALESCE(SUM(hours), 0) INTO v_same_total
      FROM public.salary_absence_days
     WHERE employee_id = v_employee_id
       AND absence_date = v_date
       AND id <> NEW.id;

  ELSE
    -- Defensive: should not be reachable given the trigger bindings below.
    RETURN NEW;
  END IF;

  v_total := v_other_total + v_same_total + NEW.hours;

  IF v_total > 24 THEN
    RAISE EXCEPTION 'Total tid (arbete + frånvaro) för % får inte överstiga 24 timmar (försökte boka %, befintligt %)',
      v_date, NEW.hours, (v_other_total + v_same_total)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salary_worked_days_24h_cap
  BEFORE INSERT OR UPDATE ON public.salary_worked_days
  FOR EACH ROW EXECUTE FUNCTION public.check_salary_day_hours_cap();

CREATE TRIGGER salary_absence_days_24h_cap
  BEFORE INSERT OR UPDATE ON public.salary_absence_days
  FOR EACH ROW EXECUTE FUNCTION public.check_salary_day_hours_cap();

NOTIFY pgrst, 'reload schema';
