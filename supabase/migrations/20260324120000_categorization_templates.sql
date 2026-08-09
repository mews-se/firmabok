-- Migration: categorization_templates
-- Per-tenant counterparty-based categorization templates.
-- Learned from user categorizations, SIE imports, or SNI defaults.
-- Slots into the categorization chain between mapping_rules and static booking templates.

CREATE TABLE public.categorization_templates (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,

  -- Counterparty identity
  counterparty_name   TEXT NOT NULL,                    -- normalized canonical name
  counterparty_aliases TEXT[] NOT NULL DEFAULT '{}',     -- raw name variants seen

  -- Accounting mapping
  debit_account       TEXT NOT NULL,                    -- BAS account number (string)
  credit_account      TEXT NOT NULL,                    -- BAS account number (string)
  vat_treatment       TEXT,                             -- standard_25, reduced_12, etc.
  vat_account         TEXT,                             -- 2611/2621/2631/2641
  category            TEXT,                             -- TransactionCategory for reverse lookup

  -- Confidence signals
  occurrence_count    INTEGER NOT NULL DEFAULT 1,
  confidence          NUMERIC NOT NULL DEFAULT 0.5
                        CHECK (confidence >= 0 AND confidence <= 1),
  last_seen_date      DATE,

  -- Source tracking
  source              TEXT NOT NULL DEFAULT 'user_approved'
                        CHECK (source IN ('sie_import', 'user_approved', 'sni_default', 'auto_learned')),

  -- Metadata
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One template per counterparty per user (upsert-friendly)
  UNIQUE (user_id, counterparty_name)
);

-- RLS
ALTER TABLE public.categorization_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categorization_templates_select" ON public.categorization_templates
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "categorization_templates_insert" ON public.categorization_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "categorization_templates_update" ON public.categorization_templates
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "categorization_templates_delete" ON public.categorization_templates
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_categorization_templates_user_id
  ON public.categorization_templates (user_id);
CREATE INDEX idx_categorization_templates_counterparty
  ON public.categorization_templates (user_id, counterparty_name);
CREATE INDEX idx_categorization_templates_aliases
  ON public.categorization_templates USING GIN (counterparty_aliases);
CREATE INDEX idx_categorization_templates_active
  ON public.categorization_templates (user_id, is_active)
  WHERE is_active = TRUE;

-- updated_at trigger
CREATE TRIGGER categorization_templates_updated_at
  BEFORE UPDATE ON public.categorization_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
