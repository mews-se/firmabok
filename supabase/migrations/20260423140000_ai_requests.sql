-- ai_requests: structured asks from the AI agent to the user.
--
-- When the AI agent cannot produce a proposal because something is missing or
-- ambiguous (blurry receipt, no candidate transactions, uncertain VAT), it
-- creates an ai_requests row instead of an ai_proposals row. The UI renders
-- these as actionable cards with typed forms.
--
-- One open request per (subject, request_type) enforced by a partial unique
-- index so the orchestrator can safely re-issue on retries without creating
-- duplicates.

CREATE TABLE IF NOT EXISTS public.ai_requests (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- What the request is about
  subject_type          text NOT NULL
                          CHECK (subject_type IN ('inbox_item')),
  subject_id            uuid NOT NULL,

  -- What the AI is asking for
  request_type          text NOT NULL
                          CHECK (request_type IN (
                            'reupload_document',
                            'pick_transaction',
                            'specify_vat',
                            'clarify_business_private',
                            'needs_manual'
                          )),
  message               text NOT NULL,
  required_fields       jsonb,
  options               jsonb,

  -- Lifecycle
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'resolved', 'dismissed')),
  response_json         jsonb,
  resolved_at           timestamptz,
  resolved_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Provenance
  model                 text,
  prompt_version        text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Only one open request per (subject, request_type) at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_requests_one_open_per_subject_type
  ON public.ai_requests (subject_type, subject_id, request_type)
  WHERE status = 'open';

-- Lookup by company
CREATE INDEX IF NOT EXISTS idx_ai_requests_company_status
  ON public.ai_requests (company_id, status);

-- Lookup by subject (for cascading when the inbox item is processed)
CREATE INDEX IF NOT EXISTS idx_ai_requests_subject
  ON public.ai_requests (subject_type, subject_id);

-- RLS: company-scoped using user_company_ids()
ALTER TABLE public.ai_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_requests_select" ON public.ai_requests;
CREATE POLICY "ai_requests_select" ON public.ai_requests
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "ai_requests_insert" ON public.ai_requests;
CREATE POLICY "ai_requests_insert" ON public.ai_requests
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "ai_requests_update" ON public.ai_requests;
CREATE POLICY "ai_requests_update" ON public.ai_requests
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- updated_at trigger
DROP TRIGGER IF EXISTS ai_requests_updated_at ON public.ai_requests;
CREATE TRIGGER ai_requests_updated_at
  BEFORE UPDATE ON public.ai_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
