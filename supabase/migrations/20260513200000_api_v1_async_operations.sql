-- Migration: api_v1_async_operations
--
-- Substrate for the v1 async-operation lifecycle. Distinct from
-- `pending_operations` (which is the "stage and wait for human approval"
-- substrate used by the MCP write tools) — this table tracks long-running
-- jobs initiated by v1 callers that the API needs to report progress + final
-- status against, without blocking the request cycle.
--
-- Response contract (per the Phase 4 plan):
--   POST returns 202 with { operation_id, status: 'queued', poll_url, webhook_event }
--   GET /v1/operations/{id} returns { operation_id, type, status, progress, result, error, started_at, completed_at }
--
-- Used by:
--   - POST /fiscal-periods/{id}/close
--   - POST /fiscal-periods/{id}/year-end
--   - POST /fiscal-periods/{id}/currency-revaluation
--   - POST /imports/sie     (future PR)
--   - POST /imports/bank    (future PR)
--   - POST /salary-runs/{id}/generate-agi   (future PR)
--
-- Phase 4 PR-2 ships this with synchronous execution inside the POST handler
-- (status flips queued → running → succeeded/failed in one request cycle).
-- A future PR can introduce a Vercel cron worker that picks up `queued` rows
-- and processes them out-of-band; the row format remains stable.

CREATE TABLE IF NOT EXISTS public.operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Operation identity
  operation_type  text NOT NULL,
  -- Free-form tag for which v1 surface initiated this op (e.g.
  -- 'fiscal_periods.close', 'fiscal_periods.year_end', 'imports.sie').
  -- The set of accepted values is open by design — adding a new async
  -- endpoint should not require an enum migration.

  -- Lifecycle
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  started_at      timestamptz,
  completed_at    timestamptz,

  -- Payload
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb,
  error           jsonb,

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.operations ENABLE ROW LEVEL SECURITY;

-- Members of the company can read their company's operations. Only the
-- service role writes (via the v1 wrapper); no anon/authenticated INSERT/
-- UPDATE/DELETE policy is exposed.
CREATE POLICY "operations_select"
  ON public.operations FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER operations_updated_at
  BEFORE UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes:
--   - Polling: GET /v1/operations/{id} is point-lookup on PK.
--   - Listing by company + recency for future GET /v1/operations endpoint.
--   - Worker queries (future cron): pick up oldest `queued` ops per company.
CREATE INDEX idx_operations_company_created
  ON public.operations (company_id, created_at DESC);

CREATE INDEX idx_operations_status_queued
  ON public.operations (created_at)
  WHERE status = 'queued';

NOTIFY pgrst, 'reload schema';
