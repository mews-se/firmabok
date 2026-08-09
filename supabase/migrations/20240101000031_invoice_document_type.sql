-- Add document_type and converted_from_id to invoices
-- Supports proforma invoices and delivery notes alongside standard invoices

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'invoice'
    CHECK (document_type IN ('invoice', 'proforma', 'delivery_note'));

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS converted_from_id uuid
    REFERENCES public.invoices(id) ON DELETE SET NULL;

-- Index for filtering by document type
CREATE INDEX IF NOT EXISTS idx_invoices_document_type
  ON public.invoices (document_type);

-- Index for looking up conversions
CREATE INDEX IF NOT EXISTS idx_invoices_converted_from_id
  ON public.invoices (converted_from_id)
  WHERE converted_from_id IS NOT NULL;
