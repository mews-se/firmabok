-- Track used OAuth authorization codes to prevent replay attacks (OAuth 2.1 §4.1.2)
-- Only accessed by service role client, no RLS needed
CREATE TABLE public.oauth_used_codes (
  code_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for cleanup queries
CREATE INDEX idx_oauth_used_codes_created_at ON public.oauth_used_codes (created_at);
