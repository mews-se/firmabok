-- The initial tax-adjustment migration used membership-only write policies.
-- Align writes with the global role gate: only a non-viewer member may write,
-- and only for the caller's active company.

ALTER TABLE public.fiscal_period_tax_adjustments
  ALTER COLUMN id SET DEFAULT uuid_generate_v4();

-- Serialize adjustment writes with fiscal-period close/lock updates. The row
-- lock prevents a concurrent request from saving tax inputs after closing has
-- started but before the period status change becomes visible.
CREATE OR REPLACE FUNCTION public.guard_fiscal_period_tax_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  adjustment_row public.fiscal_period_tax_adjustments%ROWTYPE;
  period_row public.fiscal_periods%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.company_id IS DISTINCT FROM NEW.company_id
       OR OLD.fiscal_period_id IS DISTINCT FROM NEW.fiscal_period_id
     ) THEN
    RAISE EXCEPTION 'Tax adjustment company and fiscal period are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    adjustment_row := OLD;
  ELSE
    adjustment_row := NEW;
  END IF;

  SELECT * INTO period_row
  FROM public.fiscal_periods
  WHERE id = adjustment_row.fiscal_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found for tax adjustment'
      USING ERRCODE = '23503';
  END IF;

  IF period_row.company_id IS DISTINCT FROM adjustment_row.company_id THEN
    RAISE EXCEPTION 'Tax adjustment company does not match fiscal period company'
      USING ERRCODE = '23514';
  END IF;

  IF period_row.is_closed
     OR period_row.locked_at IS NOT NULL
     OR period_row.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked for tax adjustments'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "insert own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments;
CREATE POLICY "insert own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR INSERT TO public
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "update own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments;
CREATE POLICY "update own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR UPDATE TO public
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "delete own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments;
CREATE POLICY "delete own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR DELETE TO public
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

-- Only the corporate-tax disposition sets source_id to the fiscal period.
-- This database invariant closes the read-then-insert race between two POSTs.
CREATE UNIQUE INDEX uq_year_end_corporate_tax_per_period
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'year_end'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

NOTIFY pgrst, 'reload schema';
