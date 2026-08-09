-- Add last_integrity_check_at column for document integrity verification cron
-- Tracks when each document was last verified, allowing the cron to prioritize
-- unchecked or least-recently-checked documents.

ALTER TABLE public.document_attachments
  ADD COLUMN last_integrity_check_at timestamptz;

-- Index for efficient ordering in the verification cron (nulls first = unchecked prioritized)
CREATE INDEX idx_document_attachments_integrity_check
  ON public.document_attachments (last_integrity_check_at ASC NULLS FIRST)
  WHERE is_current_version = true;
