-- Add refresh_token_hash to api_keys for OAuth refresh-token grant support.
-- OAuth-issued keys store a SHA-256 hashed refresh token here. Direct API
-- keys (created via the settings UI) leave this column NULL.
ALTER TABLE public.api_keys
  ADD COLUMN refresh_token_hash text;

CREATE UNIQUE INDEX idx_api_keys_refresh_token_hash
  ON public.api_keys (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

NOTIFY pgrst, 'reload schema';
