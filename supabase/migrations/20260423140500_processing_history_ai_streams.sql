-- Extend processing_history to cover the AI agent streams.
--
-- 1) Add 'AIProposal' and 'AIRequest' to the aggregate_type CHECK constraint.
-- 2) Register the new event types in processing_event_types:
--      AIProposalGenerated, AIProposalAccepted, AIProposalRejected,
--      AIProposalSkipped, AIProposalInvalidated, AIRequestCreated,
--      AIRequestResolved.
--
-- Events are written by the orchestrator (lib/ai/orchestrator.ts) and the
-- proposal API routes, using the same correlation_id that was threaded
-- through the document from ingest onward.

ALTER TABLE public.processing_history
  DROP CONSTRAINT IF EXISTS processing_history_aggregate_type_check;

ALTER TABLE public.processing_history
  ADD CONSTRAINT processing_history_aggregate_type_check
  CHECK (aggregate_type IN (
    'Document',
    'BankTransaction',
    'MatchProposal',
    'Verifikation',
    'CounterpartyTemplate',
    'Period',
    'Migration',
    'System',
    'AIProposal',
    'AIRequest'
  ));

INSERT INTO public.processing_event_types (event_type) VALUES
  ('AIProposalGenerated'),
  ('AIProposalAccepted'),
  ('AIProposalRejected'),
  ('AIProposalSkipped'),
  ('AIProposalInvalidated'),
  ('AIRequestCreated'),
  ('AIRequestResolved')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
