-- Add oauth_state for CSRF protection during OAuth callback
ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS oauth_state text;

-- Add last_expiry_notification_at for consent expiry notification tracking
ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS last_expiry_notification_at timestamptz;

-- Index on oauth_state for fast lookup during callback (partial — only non-null)
CREATE INDEX idx_bank_connections_oauth_state
  ON public.bank_connections (oauth_state)
  WHERE oauth_state IS NOT NULL;
