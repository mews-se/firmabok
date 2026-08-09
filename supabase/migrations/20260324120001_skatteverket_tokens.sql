-- Skatteverket OAuth2 token storage
--
-- Stores encrypted access/refresh tokens from the Skatteverket
-- `per` (BankID) OAuth2 flow. One row per user.
-- Tokens are AES-256-GCM encrypted at the application layer.

CREATE TABLE public.skatteverket_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  access_token TEXT NOT NULL,         -- AES-256-GCM encrypted
  refresh_token TEXT,                 -- AES-256-GCM encrypted
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_count INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'momsdeklaration',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- RLS
ALTER TABLE public.skatteverket_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own Skatteverket tokens"
  ON public.skatteverket_tokens FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own Skatteverket tokens"
  ON public.skatteverket_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own Skatteverket tokens"
  ON public.skatteverket_tokens FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own Skatteverket tokens"
  ON public.skatteverket_tokens FOR DELETE
  USING (auth.uid() = user_id);

-- updated_at trigger
CREATE TRIGGER update_skatteverket_tokens_updated_at
  BEFORE UPDATE ON public.skatteverket_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
