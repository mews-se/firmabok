-- Migration: idempotency_keys table for safe agent retries.
--
-- Why this exists: agent-driven write operations (MCP tools, automation
-- webhooks) must be safe to retry — agents transparently re-call on
-- network blips, timeouts, or LLM-mediated retry loops. Without an
-- idempotency layer, retrying a `create_invoice` after a network blip can
-- create two invoices and double-book the revenue.
--
-- Lifecycle:
--   1. Caller sends an `idempotency_key` (random nonce per logical operation)
--   2. Server consults this table; on hit, returns the cached response
--   3. On miss, server proceeds normally and stores the response
--   4. Cleanup cron deletes rows older than 24h
--
-- The (user_id, key) pair is unique — a key is scoped to one user so an
-- agent in account A cannot collide with account B even if they reuse the
-- same UUID.
--
-- request_hash: SHA-256 of the canonical request body. Lets us detect
-- "same key, different payload" misuse and return 409 Conflict instead of
-- silently returning the cached response for a different request.

CREATE TABLE public.idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'mcp_tool', -- 'mcp_tool' | 'api_route' | future
  response_status TEXT NOT NULL CHECK (response_status IN ('success', 'error')),
  response_body   JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

-- Unique key per user — same key in different accounts cannot collide.
CREATE UNIQUE INDEX idx_idempotency_keys_user_key
  ON public.idempotency_keys (user_id, key);

-- TTL index supports cleanup cron (delete where expires_at < now()).
CREATE INDEX idx_idempotency_keys_expires
  ON public.idempotency_keys (expires_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Service role writes; users can read their own rows for debugging.
CREATE POLICY "idempotency_keys_select_own" ON public.idempotency_keys
  FOR SELECT USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies — writes via service role only.

NOTIFY pgrst, 'reload schema';
