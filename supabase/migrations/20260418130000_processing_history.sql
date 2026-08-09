-- Processing history (behandlingshistorik)
-- Append-only event log recording every legally significant act per BFNAR 2013:2 kap 8.
-- 7-year retention enforced at application layer (not DB trigger) to allow GDPR redaction.
-- Immutable: UPDATE blocked via audit_log_immutable() trigger.
--
-- seq ordering: BIGSERIAL assigns at statement time, not commit time.
-- Two concurrent transactions may produce seq values out of commit order.
-- For legally meaningful ordering, use occurred_at. seq is a cursor for polling.

-- =============================================================
-- 1. Event type reference table
-- =============================================================
-- Adding a new event type = INSERT, no ALTER TABLE required.

CREATE TABLE public.processing_event_types (
  event_type TEXT PRIMARY KEY
);

ALTER TABLE public.processing_event_types ENABLE ROW LEVEL SECURITY;

-- Readable by all authenticated users (reference data)
CREATE POLICY "processing_event_types_select" ON public.processing_event_types
  FOR SELECT USING (true);

-- Seed the v0.2 event catalog (28 types)
INSERT INTO public.processing_event_types (event_type) VALUES
  -- Document stream
  ('DocumentIngested'),
  ('DocumentExtractionAttempted'),
  ('DocumentClassified'),
  ('DocumentRejected'),
  ('DocumentArchived'),
  ('DocumentSupersededByDuplicate'),
  -- BankTransaction stream
  ('BankTransactionIngested'),
  ('BankTransactionEnriched'),
  -- MatchProposal stream
  ('MatchAttemptedDeterministic'),
  ('MatchAttemptedLlm'),
  ('MatchConfirmed'),
  ('MatchRejected'),
  -- Verifikation stream
  ('ForslagCreated'),
  ('ForslagMutated'),
  ('VerifikationCommitted'),
  ('RättelseverifikationIssued'),
  ('ForslagAbandoned'),
  -- CounterpartyTemplate stream
  ('CounterpartyObserved'),
  ('TemplateStrengthened'),
  ('TemplateBroken'),
  -- Period stream
  ('PeriodCloseInitiated'),
  ('PeriodClosed'),
  ('PeriodReopened'),
  -- Migration stream
  ('MigrationInitiated'),
  ('MigrationValidated'),
  ('MigrationCommitted'),
  -- System stream
  ('TimingCeilingTriggered'),
  ('RubricVersionPublished');

-- =============================================================
-- 2. Processing history table
-- =============================================================

CREATE TABLE public.processing_history (
  event_id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seq                   BIGSERIAL UNIQUE NOT NULL,
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  correlation_id        UUID NOT NULL,
  causation_id          UUID REFERENCES public.processing_history(event_id),
  aggregate_type        TEXT NOT NULL CHECK (aggregate_type IN (
                          'Document',
                          'BankTransaction',
                          'MatchProposal',
                          'Verifikation',
                          'CounterpartyTemplate',
                          'Period',
                          'Migration',
                          'System'
                        )),
  aggregate_id          UUID NOT NULL,
  event_type            TEXT NOT NULL REFERENCES public.processing_event_types(event_type),
  payload               JSONB NOT NULL DEFAULT '{}',
  payload_schema_version SMALLINT NOT NULL DEFAULT 1,
  actor                 JSONB NOT NULL,
  rubric_version        TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL,
  appended_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: append-only table
);

-- =============================================================
-- 3. Row-level security
-- =============================================================

ALTER TABLE public.processing_history ENABLE ROW LEVEL SECURITY;

-- SELECT: users can read their companies' processing history
CREATE POLICY "processing_history_select" ON public.processing_history
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- Writes via service role client only.

-- =============================================================
-- 4. Indexes
-- =============================================================

-- Aggregate history: "full history of this document/transaction/verifikation"
CREATE INDEX idx_ph_aggregate
  ON public.processing_history (company_id, aggregate_type, aggregate_id, seq);

-- Event type filtering: "all VerifikationCommitted events for this company"
CREATE INDEX idx_ph_company_event_type
  ON public.processing_history (company_id, event_type, seq);

-- Time range: "all events for this company in March 2026" + retention cleanup
CREATE INDEX idx_ph_company_occurred
  ON public.processing_history (company_id, occurred_at);

-- =============================================================
-- 5. Immutability trigger
-- =============================================================
-- Reuses audit_log_immutable() which unconditionally blocks all UPDATE operations.

CREATE TRIGGER processing_history_no_update
  BEFORE UPDATE ON public.processing_history
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

-- =============================================================
-- 6. Schema reload
-- =============================================================

NOTIFY pgrst, 'reload schema';
