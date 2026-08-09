-- Add optional expiry to calendar feed tokens
-- Null = no expiry (preserves existing tokens)
ALTER TABLE calendar_feeds
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN calendar_feeds.expires_at IS 'Optional token expiry. Null means the token never expires.';
