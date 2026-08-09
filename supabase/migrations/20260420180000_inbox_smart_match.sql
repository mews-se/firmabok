-- inbox-smart-match extension schema additions
-- Adds correlation_id (audit chain) and match_reasoning (LLM explanation)
-- and expands match_method to include 'llm' and 'pending_transaction'.

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS match_reasoning text;

-- Expand allowed match_method values
ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_match_method_check;

ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_match_method_check
  CHECK (match_method IN (
    'payment_reference',
    'amount_date',
    'amount_merchant',
    'receipt_match',
    'llm',
    'pending_transaction'
  ));

-- Index for retroactive matcher queries ("find all receipts awaiting a transaction for this company")
CREATE INDEX IF NOT EXISTS idx_inbox_items_pending_match
  ON public.invoice_inbox_items(company_id)
  WHERE document_type = 'receipt'
    AND match_method = 'pending_transaction'
    AND status = 'ready';

-- Index for correlation-id audit queries
CREATE INDEX IF NOT EXISTS idx_inbox_items_correlation_id
  ON public.invoice_inbox_items(correlation_id)
  WHERE correlation_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
