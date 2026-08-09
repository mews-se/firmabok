-- Add document_id to receipts for linking receipt images to WORM archive documents
ALTER TABLE public.receipts
  ADD COLUMN document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL;

-- Index for efficient lookups
CREATE INDEX idx_receipts_document_id ON public.receipts (document_id);
