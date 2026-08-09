-- AI usage tracking for token consumption monitoring
CREATE TABLE IF NOT EXISTS ai_usage_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  extension_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_date DATE NOT NULL DEFAULT current_date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE ai_usage_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage"
  ON ai_usage_tracking FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own usage"
  ON ai_usage_tracking FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Indexes for efficient querying
CREATE INDEX idx_ai_usage_tracking_user_date
  ON ai_usage_tracking (user_id, usage_date);

CREATE INDEX idx_ai_usage_tracking_user_ext_date
  ON ai_usage_tracking (user_id, extension_id, usage_date);
