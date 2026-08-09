-- =============================================================================
-- Booking Template Usage (per-company MRU tracking)
-- =============================================================================
--
-- Tracks when a booking template was last used *within a specific company*.
-- Stored separately from booking_template_library because:
--   1. System templates are shared globally (is_system = TRUE, company_id NULL)
--      so a per-row last_used_at would be useless — company A using a template
--      would surface it for company B too.
--   2. Team templates are shared across a team's companies; each company should
--      track its own usage independently.
--
-- One row per (template_id, company_id). Upsert on use.

CREATE TABLE IF NOT EXISTS public.booking_template_usage (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id     UUID NOT NULL REFERENCES public.booking_template_library(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (template_id, company_id)
);

-- RLS
ALTER TABLE public.booking_template_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "btu_select" ON public.booking_template_usage;
CREATE POLICY "btu_select" ON public.booking_template_usage
  FOR SELECT USING (
    company_id IN (SELECT public.user_company_ids())
  );

DROP POLICY IF EXISTS "btu_insert" ON public.booking_template_usage;
CREATE POLICY "btu_insert" ON public.booking_template_usage
  FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
  );

DROP POLICY IF EXISTS "btu_update" ON public.booking_template_usage;
CREATE POLICY "btu_update" ON public.booking_template_usage
  FOR UPDATE USING (
    company_id IN (SELECT public.user_company_ids())
  );

DROP POLICY IF EXISTS "btu_delete" ON public.booking_template_usage;
CREATE POLICY "btu_delete" ON public.booking_template_usage
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
  );

-- Index for the sort query: fetch last_used_at for a given company.
CREATE INDEX IF NOT EXISTS idx_btu_company_last_used
  ON public.booking_template_usage (company_id, last_used_at DESC);

-- Schema reload for PostgREST
NOTIFY pgrst, 'reload schema';
