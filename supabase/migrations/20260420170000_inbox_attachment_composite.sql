-- Allow multiple invoice_inbox_items per email (one per attachment).
-- Replaces the single-column unique on resend_email_id with a composite
-- on (resend_email_id, resend_attachment_id).

DROP INDEX IF EXISTS idx_invoice_inbox_items_resend_email_id;

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS resend_attachment_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_items_resend_email_attachment
  ON public.invoice_inbox_items(resend_email_id, resend_attachment_id)
  WHERE resend_email_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
