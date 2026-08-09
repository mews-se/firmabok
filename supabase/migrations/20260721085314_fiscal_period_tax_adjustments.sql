-- Persist tax-only adjustments used by the year-end tax provision and INK2.
-- These rows do not create journal entries. They explain the bridge from the
-- accounting result to the taxable result for one fiscal period.

CREATE TABLE public.fiscal_period_tax_adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  fiscal_period_id   uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  adjustment_type    text NOT NULL CHECK (
    adjustment_type IN ('non_deductible_expense', 'non_taxable_income')
  ),
  source             text NOT NULL CHECK (source IN ('detected', 'manual')),
  source_key         text NOT NULL,
  description        text NOT NULL,
  account_number     text NULL CHECK (
    account_number IS NULL OR account_number ~ '^[0-9]{4}$'
  ),
  amount             numeric(15, 2) NOT NULL CHECK (amount >= 0),
  included           boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fiscal_period_tax_adjustments_source_key
    UNIQUE (company_id, fiscal_period_id, source_key)
);

ALTER TABLE public.fiscal_period_tax_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

CREATE POLICY "update own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

CREATE POLICY "delete own-company fiscal period tax adjustments"
  ON public.fiscal_period_tax_adjustments FOR DELETE
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_fiscal_period_tax_adjustments_company
  ON public.fiscal_period_tax_adjustments (company_id);

CREATE INDEX idx_fiscal_period_tax_adjustments_period
  ON public.fiscal_period_tax_adjustments (fiscal_period_id);

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
  WHERE id = adjustment_row.fiscal_period_id;

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

CREATE TRIGGER guard_fiscal_period_tax_adjustments
  BEFORE INSERT OR UPDATE OR DELETE ON public.fiscal_period_tax_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_period_tax_adjustment();

CREATE TRIGGER set_updated_at_fiscal_period_tax_adjustments
  BEFORE UPDATE ON public.fiscal_period_tax_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_fiscal_period_tax_adjustments
  AFTER INSERT OR UPDATE OR DELETE ON public.fiscal_period_tax_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TABLE public.fiscal_period_tax_adjustments IS
  'Tax-only adjustments bridging accounting result to taxable result for year-end tax and INK2.';

NOTIFY pgrst, 'reload schema';
