-- Re-add matched_transaction_id on invoice_inbox_items.
--
-- The 20260504180000 migration removed this column along with all the AI
-- metadata (match_confidence / match_method / match_reasoning) because the
-- AI subsystem was retired. But the back-reference itself isn't an AI
-- artifact — it's how the inbox UI knows an item has been linked to a
-- bank transaction (symmetric with `created_supplier_invoice_id` which
-- already marks supplier-invoice processing).
--
-- The "Koppla till transaktion" and "Skapa transaktion från underlag"
-- flows both need this column so the inbox can show a "Kopplad" badge
-- and link back to the matched transaction.

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS matched_transaction_id uuid
  REFERENCES public.transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_items_matched_transaction
  ON public.invoice_inbox_items(company_id, matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
