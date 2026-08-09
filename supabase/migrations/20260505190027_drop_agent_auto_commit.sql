-- Migration: Drop agent auto-commit feature.
--
-- Removes the columns and constraints introduced by:
--   - 20260430120000_pending_operations_actor_and_risk.sql (auto_commit_*)
--   - 20260501120000_company_settings_auto_commit.sql (agent_auto_commit_*)
--
-- The actor model and risk_level are kept — those are still useful for
-- attribution and the /pending UI's "Hög risk" filter. We're only ripping
-- out the auto-commit half.

-- =============================================================================
-- 1. pending_operations: drop auto-commit columns + supporting constraint/index
-- =============================================================================

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_ops_auto_commit_status;

DROP INDEX IF EXISTS public.idx_pending_ops_auto_committed;

ALTER TABLE public.pending_operations
  DROP COLUMN IF EXISTS auto_commit_eligible,
  DROP COLUMN IF EXISTS auto_committed_at;

-- =============================================================================
-- 2. company_settings: drop the opt-in toggle and threshold
-- =============================================================================

ALTER TABLE public.company_settings
  DROP COLUMN IF EXISTS agent_auto_commit_enabled,
  DROP COLUMN IF EXISTS agent_auto_commit_max_amount;

-- =============================================================================
-- 3. PostgREST schema reload
-- =============================================================================
NOTIFY pgrst, 'reload schema';
