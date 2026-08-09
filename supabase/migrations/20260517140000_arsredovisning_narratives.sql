-- arsredovisning_narratives — persists the free-text förvaltningsberättelse
-- fields (description, important_events, resultatdisposition) that the user
-- edits in the ÅR page. Replaces the URL-query-param carry from PR #509 —
-- those params leaked narrative content into access logs and browser history,
-- and the URL state couldn't survive a refresh or be shared between users.
--
-- One row per fiscal_period_id (UNIQUE), upserted by the page's save action.
-- The PDF route reads from here as overrides on top of the auto-generated
-- boilerplate in buildArsredovisningData.
--
-- Also tightens signer_name to VARCHAR(200) at the storage layer to match
-- the API-layer .max(200) guard added in PR #509 (round-2 polish, GDPR Art.25.2
-- data-minimization). The API caps it; the column enforces it.

CREATE TABLE public.arsredovisning_narratives (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_period_id      UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE CASCADE,
  description           TEXT CHECK (length(description) <= 4000),
  important_events      TEXT CHECK (length(important_events) <= 4000),
  resultatdisposition   TEXT CHECK (length(resultatdisposition) <= 2000),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT arsredovisning_narratives_unique_period UNIQUE (fiscal_period_id)
);

CREATE INDEX idx_arsredovisning_narratives_company
  ON public.arsredovisning_narratives (company_id);

ALTER TABLE public.arsredovisning_narratives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "arsredovisning_narratives_select" ON public.arsredovisning_narratives
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "arsredovisning_narratives_insert" ON public.arsredovisning_narratives
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "arsredovisning_narratives_update" ON public.arsredovisning_narratives
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "arsredovisning_narratives_delete" ON public.arsredovisning_narratives
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER arsredovisning_narratives_updated_at
  BEFORE UPDATE ON public.arsredovisning_narratives
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tighten signer_name length at storage layer (matches API .max(200)).
ALTER TABLE public.arsredovisning_signature_requests
  ADD CONSTRAINT arsredovisning_sigreq_signer_name_max
  CHECK (length(signer_name) <= 200);

NOTIFY pgrst, 'reload schema';
