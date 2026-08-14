-- Hardening follow-up to 20260420180000_inbox_smart_match.
--
-- Fixes the dual-match race in inbox-smart-match (two receipts could both
-- pair themselves to the same transaction). Enforced by partial unique
-- index; process-match catches 23505 and falls back to pending.

-- =============================================================================
-- Prevent two inbox items from claiming the same transaction
-- =============================================================================

-- Partial unique index: once a row has matched_transaction_id set for a
-- given company, no other row in that company may claim the same one.
-- Concurrent UPDATEs from smart-match will get a 23505 and the handler
-- gracefully downgrades the loser to pending_transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_matched_transaction_unique
  ON public.invoice_inbox_items(company_id, matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
