-- ai_proposals: the staging layer for AI-generated bookkeeping proposals.
--
-- When the AI agent can produce a concrete suggestion for a step in the
-- receipt flow (match, booking), it writes a row here with status='pending'.
-- The user accepts, rejects, edits, or skips via the /agent-inbox UI.
-- Nothing touches the ledger until a pending proposal is explicitly accepted;
-- at that point the apply path calls the engine and links applied_entry_id.
--
-- A partial unique index enforces "one pending proposal per (subject, step)"
-- so concurrent generation is idempotent — a new proposal for an already-
-- pending (subject, step) pair invalidates the prior one first.

CREATE TABLE IF NOT EXISTS public.ai_proposals (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Subject: what this proposal is about
  subject_type          text NOT NULL
                          CHECK (subject_type IN ('inbox_item')),
  subject_id            uuid NOT NULL,

  -- Step in the agent pipeline: 'match' (document -> transaction) then 'booking' (journal entry)
  step_type             text NOT NULL
                          CHECK (step_type IN ('match', 'booking')),

  -- Lifecycle
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'rejected', 'skipped', 'invalidated')),
  version               integer NOT NULL DEFAULT 1,   -- optimistic-lock counter

  -- Payload: step-shaped JSON (MatchProposalPayload | BookingProposalPayload)
  proposal_json         jsonb NOT NULL,

  -- Confidence is informational only — user always confirms
  confidence            numeric(5,4)
                          CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reasoning             text,

  -- Link to an open ai_request when the AI would rather ask than guess
  ai_request_id         uuid REFERENCES public.ai_requests(id) ON DELETE SET NULL,

  -- Provenance (for audit + prompt/model drift analysis)
  model                 text NOT NULL,
  prompt_version        text NOT NULL,
  input_token_count     integer NOT NULL DEFAULT 0,
  output_token_count    integer NOT NULL DEFAULT 0,

  -- Outcome tracking
  edit_diff             jsonb,    -- set when user edited before accept
  applied_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  invalidated_reason    text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  accepted_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One pending proposal per (subject, step) — idempotency guard
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_one_pending_per_step
  ON public.ai_proposals (subject_type, subject_id, step_type)
  WHERE status = 'pending';

-- List queries
CREATE INDEX IF NOT EXISTS idx_ai_proposals_company_status
  ON public.ai_proposals (company_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_proposals_company_created_at
  ON public.ai_proposals (company_id, created_at DESC);

-- Subject lookup (cascade when the inbox item is processed manually)
CREATE INDEX IF NOT EXISTS idx_ai_proposals_subject
  ON public.ai_proposals (subject_type, subject_id);

-- RLS: company-scoped using user_company_ids()
ALTER TABLE public.ai_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_proposals_select" ON public.ai_proposals
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "ai_proposals_insert" ON public.ai_proposals
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "ai_proposals_update" ON public.ai_proposals
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- updated_at trigger
CREATE TRIGGER ai_proposals_updated_at
  BEFORE UPDATE ON public.ai_proposals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
