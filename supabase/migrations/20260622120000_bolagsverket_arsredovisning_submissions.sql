-- Digital inlämning av årsredovisning till Bolagsverket — submission state.
--
-- Three tables backing the bolagsverket extension:
--   1. arsredovisning_submissions      — one row per filing attempt (state
--      machine draft → kontrollerad → uploaded → inkommen → [förelagd ↔
--      komplettering] → registrerad | avslutad | error). Immutable after
--      upload except the status-tracking fields (mirrors the accounting
--      guard-rail philosophy: what was sent to the authority never mutates).
--   2. bolagsverket_avtal_acceptances  — GUIDE §4.2: the avtalstext returned
--      by skapa-inlamningtoken MUST be shown and accepted per company before
--      kontrollera/inlämning may run; re-shown when avtalstextAndrad changes.
--   3. bolagsverket_subscriptions      — händelseprenumerationer (GUIDE §5.4):
--      per-company webhook registration incl. the `auth` header secret we set
--      at subscription time and the 6-month expiry for idempotent re-subscribe.
--
-- Personnummer (avsändare + undertecknare) are REQUIRED by the API but are
-- GDPR-sensitive — only SHA-256 hashes are persisted (open decision #1 in
-- dev_docs/bokslut/arsredovisning_implementation.md resolved as transient).

-- =============================================================================
-- 1. arsredovisning_submissions
-- =============================================================================
CREATE TABLE public.arsredovisning_submissions (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL (not CASCADE): a filing attempt against the authority
  -- is audit history for the COMPANY — it must survive deletion of the user
  -- account that happened to press the button.
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  fiscal_period_id      uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  handling_typ          text NOT NULL DEFAULT 'arsredovisning_komplett'
                        CHECK (handling_typ IN ('arsredovisning_komplett', 'arsredovisning', 'revisionsberattelse')),
  taxonomy_version      text NOT NULL,
  entry_point           text NOT NULL,
  environment           text NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'accept', 'prod')),
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'kontrollerad', 'uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad', 'error')),
  undertecknare_namn    text,
  undertecknare_epost   text,
  undertecknare_pnr_hash text,
  avsandare_pnr_hash    text,
  -- Response fields from inlämning (GUIDE §5.3.3)
  idnummer              text,
  sha256_checksumma     text,
  kontrollsumma         text,
  bolagsverket_url      text,
  kontrollera_utfall    jsonb,
  -- Generated .xhtml stored as räkenskapsinformation (7-year retention) via
  -- the documents service; linked here for traceability.
  dokument_id           uuid REFERENCES public.document_attachments(id),
  error_message         text,
  uploaded_at           timestamptz,
  registered_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.arsredovisning_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company arsredovisning submissions"
  ON public.arsredovisning_submissions FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company arsredovisning submissions"
  ON public.arsredovisning_submissions FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company arsredovisning submissions"
  ON public.arsredovisning_submissions FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
-- No DELETE policy: a filing attempt against the authority is part of the
-- audit trail; rows are closed via status, never removed by users.

CREATE INDEX idx_arsred_submissions_company
  ON public.arsredovisning_submissions (company_id, fiscal_period_id);
CREATE INDEX idx_arsred_submissions_status
  ON public.arsredovisning_submissions (company_id, status);
-- The webhook receiver correlates by document idnummer.
CREATE INDEX idx_arsred_submissions_idnummer
  ON public.arsredovisning_submissions (idnummer) WHERE idnummer IS NOT NULL;

CREATE TRIGGER set_updated_at_arsred_submissions
  BEFORE UPDATE ON public.arsredovisning_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_arsred_submissions
  AFTER INSERT OR UPDATE OR DELETE ON public.arsredovisning_submissions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ---- immutability + status-machine enforcement ------------------------------
-- After upload (uploaded_at set), the submission's identity and the uploaded
-- artefact's fingerprints are frozen; only the status-tracking columns may
-- move, and only along documented transitions (GUIDE §5.2.2).
CREATE OR REPLACE FUNCTION public.enforce_arsred_submission_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.uploaded_at IS NOT NULL THEN
    IF NEW.company_id        IS DISTINCT FROM OLD.company_id
    OR NEW.fiscal_period_id  IS DISTINCT FROM OLD.fiscal_period_id
    OR NEW.handling_typ      IS DISTINCT FROM OLD.handling_typ
    OR NEW.taxonomy_version  IS DISTINCT FROM OLD.taxonomy_version
    OR NEW.entry_point       IS DISTINCT FROM OLD.entry_point
    OR NEW.environment       IS DISTINCT FROM OLD.environment
    OR NEW.idnummer          IS DISTINCT FROM OLD.idnummer
    OR NEW.sha256_checksumma IS DISTINCT FROM OLD.sha256_checksumma
    OR NEW.kontrollsumma     IS DISTINCT FROM OLD.kontrollsumma
    OR NEW.dokument_id       IS DISTINCT FROM OLD.dokument_id
    OR NEW.undertecknare_pnr_hash IS DISTINCT FROM OLD.undertecknare_pnr_hash
    OR NEW.avsandare_pnr_hash     IS DISTINCT FROM OLD.avsandare_pnr_hash
    OR NEW.uploaded_at       IS DISTINCT FROM OLD.uploaded_at
    THEN
      RAISE EXCEPTION 'Inlämnad årsredovisning kan inte ändras (submission % är uppladdad till Bolagsverket)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Post-upload statuses (inkommen/forelagd/komplettering/registrerad/
  -- avslutad) are asserted by Bolagsverket, not derived by us. Webhooks can
  -- be missed and the polling fallback may skip intermediate events, so all
  -- FORWARD jumps between externally-asserted statuses are allowed; only
  -- regressions (e.g. registrerad → draft) are rejected.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'         AND NEW.status IN ('kontrollerad', 'uploaded', 'error'))
      OR (OLD.status = 'kontrollerad' AND NEW.status IN ('kontrollerad', 'uploaded', 'error', 'draft'))
      OR (OLD.status = 'uploaded'     AND NEW.status IN ('inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad', 'error'))
      OR (OLD.status = 'inkommen'     AND NEW.status IN ('forelagd', 'komplettering', 'registrerad', 'avslutad'))
      OR (OLD.status = 'forelagd'     AND NEW.status IN ('komplettering', 'registrerad', 'avslutad'))
      OR (OLD.status = 'komplettering' AND NEW.status IN ('forelagd', 'registrerad', 'avslutad'))
      OR (OLD.status = 'error'        AND NEW.status IN ('draft', 'kontrollerad'))
    ) THEN
      RAISE EXCEPTION 'Ogiltig statusövergång för årsredovisningsinlämning: % → %', OLD.status, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_arsred_submission_immutability
  BEFORE UPDATE ON public.arsredovisning_submissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_arsred_submission_immutability();

-- =============================================================================
-- 2. bolagsverket_avtal_acceptances
-- =============================================================================
CREATE TABLE public.bolagsverket_avtal_acceptances (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL: the acceptance is an audit record of WHO accepted the
  -- Bolagsverket avtalstext for the company; it must survive user deletion.
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The avtalstextAndrad date from skapa-inlamningtoken; a NEW acceptance row
  -- is required whenever Bolagsverket bumps this (GUIDE §4.2/§5.3.1).
  avtalstext_andrad text NOT NULL,
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bolagsverket_avtal_acceptances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company avtal acceptances"
  ON public.bolagsverket_avtal_acceptances FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company avtal acceptances"
  ON public.bolagsverket_avtal_acceptances FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND user_id = auth.uid());
-- Acceptances are an audit record — no UPDATE/DELETE policies.

CREATE UNIQUE INDEX uq_bolagsverket_avtal_acceptance
  ON public.bolagsverket_avtal_acceptances (company_id, user_id, avtalstext_andrad);

-- =============================================================================
-- 3. bolagsverket_subscriptions (händelseprenumerationer)
-- =============================================================================
CREATE TABLE public.bolagsverket_subscriptions (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL: the subscription authenticates COMPANY-level webhook
  -- deliveries (the auth secret below). Cascading it away with the user who
  -- happened to register it would silently 401 all subsequent deliveries.
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  orgnr        text NOT NULL,
  url          text NOT NULL,
  -- Secret we provide as the `auth` field at subscription; Bolagsverket echoes
  -- it as an `auth` http header on every webhook delivery (GUIDE §5.4.5.2).
  auth_secret  text NOT NULL,
  environment  text NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'accept', 'prod')),
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  -- Subscriptions auto-expire after 6 months; re-subscribe after every
  -- inlämning extends this (GUIDE §4.3).
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bolagsverket_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company bolagsverket subscriptions"
  ON public.bolagsverket_subscriptions FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE UNIQUE INDEX uq_bolagsverket_subscription
  ON public.bolagsverket_subscriptions (company_id, orgnr, url, environment);

-- The webhook receiver looks subscriptions up by orgnr alone (the unique
-- index above leads with company_id and cannot serve that path).
CREATE INDEX idx_bolagsverket_subscriptions_orgnr
  ON public.bolagsverket_subscriptions (orgnr);

CREATE TRIGGER set_updated_at_bolagsverket_subscriptions
  BEFORE UPDATE ON public.bolagsverket_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
