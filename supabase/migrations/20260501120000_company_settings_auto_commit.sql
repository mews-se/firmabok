-- Migration: Auto-commit settings for agent-driven pending_operations.
--
-- Lets a company opt in to letting trusted API keys auto-commit low-risk
-- proposals (e.g. create_customer) without human approval. High-risk
-- operations (period close, year-end, send_invoice, etc.) are NEVER
-- auto-committed regardless of these settings — that's enforced in
-- lib/pending-operations/should-auto-commit.ts and risk-tiers.ts, not in
-- DB config, so it can't be bypassed.
--
-- Defaults are conservative: opt-out by default, no monetary cap configured.

ALTER TABLE public.company_settings
  ADD COLUMN agent_auto_commit_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN agent_auto_commit_max_amount NUMERIC(14, 2);

COMMENT ON COLUMN public.company_settings.agent_auto_commit_enabled IS
  'When true, low-risk pending_operations from trusted API keys may auto-commit without human approval. High-risk ops are always gated regardless.';

COMMENT ON COLUMN public.company_settings.agent_auto_commit_max_amount IS
  'Optional SEK threshold: low-risk ops above this amount still require human approval. NULL = no monetary limit beyond the risk tier check.';

NOTIFY pgrst, 'reload schema';
