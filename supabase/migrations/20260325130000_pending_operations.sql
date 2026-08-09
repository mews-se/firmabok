-- Migration: Pending Operations
-- Staging table for MCP agent write operations that require user review.
-- Agent proposes → user reviews in web UI → commits or rejects.

-- =============================================================================
-- 1. pending_operations table
-- =============================================================================
CREATE TABLE public.pending_operations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_type  TEXT NOT NULL CHECK (operation_type IN (
    'categorize_transaction', 'create_customer', 'create_invoice'
  )),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'committed', 'rejected'
  )),
  title           TEXT NOT NULL,
  params          JSONB NOT NULL DEFAULT '{}',
  preview_data    JSONB NOT NULL DEFAULT '{}',
  result_data     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: list pending ops for a user
CREATE INDEX idx_pending_ops_user_status ON public.pending_operations (user_id, status);

-- =============================================================================
-- 2. RLS
-- =============================================================================
ALTER TABLE public.pending_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_ops_select_own" ON public.pending_operations
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "pending_ops_update_own" ON public.pending_operations
  FOR UPDATE USING (auth.uid() = user_id);

-- No INSERT policy: writes via service role client from MCP handler
-- No DELETE policy: status transitions only (pending → committed/rejected)

-- =============================================================================
-- 3. updated_at trigger
-- =============================================================================
CREATE TRIGGER pending_operations_updated_at
  BEFORE UPDATE ON public.pending_operations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
