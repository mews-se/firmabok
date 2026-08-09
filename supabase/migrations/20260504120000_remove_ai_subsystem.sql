-- Remove the AI agent subsystem (receipts v1).
--
-- Drops the dedicated AI tables and the per-company toggles. Code that
-- referenced these has been deleted from lib/ai, app/api/ai, the agent-inbox
-- UI, and the three AI extensions (invoice-inbox, inbox-smart-match,
-- ai-agent).
--
-- Deliberately NOT dropped:
--   * journal_entries.created_via and journal_entries.source_proposal_id —
--     left as harmless dead columns. journal_entries is legally immutable
--     under BFL 7 kap 5 §; structural changes to that table are sensitive.
--     Defaults ('manual' / NULL) keep new inserts working without code
--     populating these fields.
--   * categorization_templates.source = 'ai_corrected' CHECK value — kept
--     as a historical/audit value. Existing rows with that source remain
--     valid; nothing new will set it.
--   * processing_event_types CHECK enum value 'MatchProposal' /
--     'AIProposal' / 'AIRequest' — kept as dead enum values for the same
--     reason; no code emits them now.
--
-- Apply via Supabase preview branch first, never directly to production.

-- journal_entries.source_proposal_id has an FK to ai_proposals
-- (ON DELETE SET NULL — applies to row deletes, not DROP TABLE).
-- Drop the constraint explicitly so the table drop succeeds; the
-- column itself stays as a dead column per the note above.
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_proposal_id_fkey;

DROP TABLE IF EXISTS public.ai_proposals;
DROP TABLE IF EXISTS public.ai_requests;
DROP TABLE IF EXISTS public.ai_usage_tracking;

ALTER TABLE public.company_settings
  DROP COLUMN IF EXISTS ai_flow_enabled,
  DROP COLUMN IF EXISTS ai_backfill_cancel_requested;

NOTIFY pgrst, 'reload schema';
