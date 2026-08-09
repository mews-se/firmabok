-- Migration: user_description_matching
-- Adds source tracking, user description text, and template_id to mapping_rules
-- to support user-description-based transaction matching.
--
-- Safe migration: all new columns have defaults or are nullable,
-- so existing rows remain valid.

-- 1. Add source column to track rule origin
ALTER TABLE public.mapping_rules
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto'
  CHECK (source IN ('auto', 'user_description', 'system'));

-- 2. Add user_description column to store the user's plain-language text
ALTER TABLE public.mapping_rules
  ADD COLUMN IF NOT EXISTS user_description TEXT;

-- 3. Add template_id column to store the confirmed booking template
ALTER TABLE public.mapping_rules
  ADD COLUMN IF NOT EXISTS template_id TEXT;

-- 4. Index for efficient upsert-on-merchant lookup by source
CREATE INDEX IF NOT EXISTS idx_mapping_rules_user_merchant_source
  ON public.mapping_rules (user_id, merchant_pattern, source);
