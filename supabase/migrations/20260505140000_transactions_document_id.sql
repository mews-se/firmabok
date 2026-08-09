-- Direct attachment of an unmatched document to a bank transaction.
-- Lets users (and AI agents via MCP) pin a forwarded/uploaded document to a
-- specific tx before categorization. The categorize route propagates this
-- to document_attachments.journal_entry_id when a journal entry is created.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS document_id uuid
  REFERENCES public.document_attachments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_document_id
  ON public.transactions (document_id)
  WHERE document_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
