-- Strip AI/LLM artifacts from invoice_inbox_items.
--
-- After the AI subsystem teardown (migration 20260504120000) the inbox is
-- restored as a deterministic ingest pipeline (pdfjs-dist + regex). Drop
-- columns that only made sense with an AI extractor / matcher / template
-- suggester. Tighten the status enum to received | error.
--
-- The extracted_data jsonb column survives — any prior parsed values from
-- the AI flow remain readable, and the new deterministic extractor writes
-- the same shape (InvoiceExtractionResult).

-- 1. Drop AI-specific columns. Done in a single ALTER for atomicity.
ALTER TABLE public.invoice_inbox_items
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS raw_llm_response,
  DROP COLUMN IF EXISTS suggested_template_id,
  DROP COLUMN IF EXISTS suggested_template_confidence,
  DROP COLUMN IF EXISTS match_confidence,
  DROP COLUMN IF EXISTS match_method,
  DROP COLUMN IF EXISTS match_reasoning,
  DROP COLUMN IF EXISTS matched_transaction_id,
  DROP COLUMN IF EXISTS linked_receipt_id,
  DROP COLUMN IF EXISTS document_type;

-- 2. Drop indexes that referenced the dropped columns. Postgres drops
--    indexes automatically when the column is dropped, but we also kill
--    composite indexes that may have used document_type.
DROP INDEX IF EXISTS public.idx_invoice_inbox_items_match_status;
DROP INDEX IF EXISTS public.idx_invoice_inbox_items_document_type;
DROP INDEX IF EXISTS public.idx_inbox_items_document_type_status;

-- 3. Tighten the status enum. Existing rows in the now-removed AI states
--    collapse to 'received'; rows that successfully created a supplier
--    invoice keep 'received' and rely on created_supplier_invoice_id IS
--    NOT NULL to mark them as processed in the UI.
ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_status_check;

UPDATE public.invoice_inbox_items
  SET status = 'received'
  WHERE status IN ('pending', 'processing', 'ready', 'confirmed', 'rejected');

ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_status_check
  CHECK (status IN ('received', 'error'));

ALTER TABLE public.invoice_inbox_items
  ALTER COLUMN status SET DEFAULT 'received';

NOTIFY pgrst, 'reload schema';
