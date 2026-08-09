-- Invoice inbox: support "book directly" flow for kontantmetoden users.
--
-- Cash-method users (and accrual users dealing with personal expenses,
-- cash receipts, etc.) need to be able to turn an inbox item directly
-- into a manual journal entry without going through a supplier invoice.
-- This column gives the inbox the third terminal status, symmetric with
-- `created_supplier_invoice_id` and `matched_transaction_id`.

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS created_journal_entry_id uuid
  REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_items_created_journal_entry
  ON public.invoice_inbox_items(company_id, created_journal_entry_id)
  WHERE created_journal_entry_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
