-- Add per-employee override columns for tax and employer contributions.
--
-- Customers reported (2026-05-28) that they need to adjust the computed
-- tax (skatteavdrag) and arbetsgivaravgift per individual employee inside
-- a salary run — common reasons:
--   * FoU-avdrag (R&D research deduction lowering avgifter ~10%)
--   * Jämkning (Skatteverket-issued personal tax adjustment)
--   * Växa-stöd corner cases not covered by salary_payroll_config
--
-- Modeled additively: the engine writes computed values into
-- tax_withheld / avgifter_amount / avgifter_basis exactly as before.
-- Booking and AGI now coalesce override → computed:
--   effective_tax = COALESCE(tax_withheld_override, tax_withheld)
-- so legacy runs continue to behave identically.
--
-- override_reason is a compliance breadcrumb required by the UI when any
-- override is set (BFL requires documentable rationale for manual tax
-- adjustments). NULL when no override is set.

ALTER TABLE public.salary_run_employees
  ADD COLUMN tax_withheld_override     numeric,
  ADD COLUMN avgifter_amount_override  numeric,
  ADD COLUMN avgifter_basis_override   numeric,
  ADD COLUMN override_reason           text;

ALTER TABLE public.salary_run_employees
  ADD CONSTRAINT salary_run_employees_override_reason_required
    CHECK (
      (tax_withheld_override IS NULL
        AND avgifter_amount_override IS NULL
        AND avgifter_basis_override IS NULL)
      OR override_reason IS NOT NULL
    );

NOTIFY pgrst, 'reload schema';
