-- Document Ingestion Phase 1: classification support
-- Adds raw LLM response storage

-- 1. Add raw_llm_response column to invoice_inbox_items
ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS raw_llm_response jsonb;

-- 2. Better index for classification cron queries on inbox items
CREATE INDEX IF NOT EXISTS idx_inbox_items_company_status_created
  ON public.invoice_inbox_items(company_id, status, created_at);
