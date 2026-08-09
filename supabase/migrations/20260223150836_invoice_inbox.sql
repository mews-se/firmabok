-- Invoice Inbox: table for incoming documents (supplier invoices, receipts, etc.)
-- Supports AI extraction, supplier matching, transaction matching, and confirm-to-create workflow

CREATE TABLE public.invoice_inbox_items (
  id                          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','processing','ready','confirmed','rejected','error')),
  source                      text NOT NULL DEFAULT 'upload'
                                CHECK (source IN ('email','upload')),

  -- Email metadata
  email_from                  text,
  email_subject               text,
  email_received_at           timestamptz,

  -- Document link
  document_id                 uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,

  -- AI extraction
  extracted_data              jsonb,
  confidence                  numeric,

  -- Supplier matching
  matched_supplier_id         uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  created_supplier_invoice_id uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,

  -- Error tracking
  error_message               text,

  -- Timestamps
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- Document type classification (supplier_invoice, receipt, government_letter, unknown)
  document_type               text NOT NULL DEFAULT 'supplier_invoice'
                                CHECK (document_type IN ('supplier_invoice','receipt','government_letter','unknown')),

  -- Receipt linking (when document_type = 'receipt')
  linked_receipt_id           uuid REFERENCES public.receipts(id) ON DELETE SET NULL,

  -- Raw email payload for reprocessing
  raw_email_payload           jsonb,

  -- AI booking template suggestion
  suggested_template_id       text,
  suggested_template_confidence numeric,

  -- Transaction matching
  matched_transaction_id      uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  match_confidence            numeric,
  match_method                text CHECK (match_method IN ('payment_reference','amount_date','amount_merchant','receipt_match'))
);

-- RLS
ALTER TABLE public.invoice_inbox_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_inbox_items_select"
  ON public.invoice_inbox_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "invoice_inbox_items_insert"
  ON public.invoice_inbox_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "invoice_inbox_items_update"
  ON public.invoice_inbox_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "invoice_inbox_items_delete"
  ON public.invoice_inbox_items FOR DELETE
  USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_invoice_inbox_items_user_id
  ON public.invoice_inbox_items(user_id);

CREATE INDEX idx_invoice_inbox_items_user_status
  ON public.invoice_inbox_items(user_id, status);

CREATE INDEX idx_invoice_inbox_items_user_created
  ON public.invoice_inbox_items(user_id, created_at DESC);

CREATE INDEX idx_inbox_items_document_type
  ON public.invoice_inbox_items(user_id, document_type, status);

CREATE INDEX idx_inbox_items_matched_transaction
  ON public.invoice_inbox_items(user_id, matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

CREATE INDEX idx_inbox_items_unmatched_ready
  ON public.invoice_inbox_items(user_id, status)
  WHERE matched_transaction_id IS NULL AND status IN ('ready', 'processing');

-- updated_at trigger
CREATE TRIGGER invoice_inbox_items_updated_at
  BEFORE UPDATE ON public.invoice_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
