-- Two changes to arsredovisning_narratives:
--
-- 1. Add agm_date column. The fastställelseintyg page (added in PR #511)
--    has a blank for the stämma-date the user has to fill in by hand,
--    which defeats the purpose of a generated document. With this column
--    the user records the AGM date once and the PDF picks it up.
--
-- 2. Change the UNIQUE constraint from (fiscal_period_id) to
--    (company_id, fiscal_period_id). The previous constraint relied on
--    UUIDs not colliding across tenants for isolation — true in practice,
--    but the constraint itself should match the tenant boundary so a logic
--    error in onConflict resolution can never overwrite another company's
--    narrative. RLS would also reject the cross-tenant write, but
--    constraint-level enforcement is stronger defense-in-depth.

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN IF NOT EXISTS agm_date DATE;

ALTER TABLE public.arsredovisning_narratives
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_unique_period;

ALTER TABLE public.arsredovisning_narratives
  ADD CONSTRAINT arsredovisning_narratives_unique_period
  UNIQUE (company_id, fiscal_period_id);

NOTIFY pgrst, 'reload schema';
