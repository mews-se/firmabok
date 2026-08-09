-- Document Ingestion Phase 1: classification support + email connections
-- Adds raw LLM response storage and Gmail OAuth connection table

-- 1. Add raw_llm_response column to invoice_inbox_items
ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS raw_llm_response jsonb;

-- 2. Email connections for Gmail OAuth
CREATE TABLE public.email_connections (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'gmail'
                    CHECK (provider IN ('gmail')),
  email_address   text NOT NULL,
  encrypted_token text NOT NULL,   -- AES-256-GCM: base64(iv):base64(authTag):base64(ciphertext)
  last_sync_at    timestamptz,
  gmail_label_id  text,            -- ID of the gnubok-processed Gmail label
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','revoked','error')),
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, email_address)
);

-- RLS
ALTER TABLE public.email_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_connections_select" ON public.email_connections
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "email_connections_insert" ON public.email_connections
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "email_connections_update" ON public.email_connections
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "email_connections_delete" ON public.email_connections
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

-- Indexes
CREATE INDEX idx_email_connections_company_status
  ON public.email_connections(company_id, status);

-- updated_at trigger
CREATE TRIGGER email_connections_updated_at
  BEFORE UPDATE ON public.email_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Better index for classification cron queries on inbox items
CREATE INDEX IF NOT EXISTS idx_inbox_items_company_status_created
  ON public.invoice_inbox_items(company_id, status, created_at);
