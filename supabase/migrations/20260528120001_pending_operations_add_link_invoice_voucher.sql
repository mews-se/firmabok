-- Expand pending_operations.operation_type to include link_invoice_voucher.
--
-- New op type lets the user mark an invoice as paid by linking an EXISTING
-- posted verifikat (whose lines already credit an AR account, default 1510)
-- instead of creating a new journal entry. Common after SIE imports, manual
-- cash receipts, or any flow where the AR-credit posting landed in the GL
-- without invoice linkage. Pure linking — only an invoice_payments row is
-- inserted; the verifikat is never modified, so this is safe against
-- enforce_period_lock (locked-period vouchers can still be linked).
--
-- Risk tier: 'medium' (lib/pending-operations/risk-tiers.ts) — reversible by
-- deleting the invoice_payments row and reverting invoice status, no booking
-- impact. Sits alongside match_transaction_invoice semantically.
--
-- Also adds the partial unique index that mirrors the existing
-- (transaction_id, invoice_id) guard: a single voucher may legitimately
-- settle multiple invoices, but linking the same voucher to the same
-- invoice twice is rejected at the DB level (matches the
-- VOUCHER_ALREADY_LINKED service guard).

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    -- Phase 0: original 7 op types
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    -- Stream 1 Phase 1: bookkeeping period operations
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'run_currency_revaluation',
    -- Stream 1 Phase 1: SIE import (export is read-only)
    'import_sie',
    -- Stream 1 Phase 1: voucher gap explanations
    'explain_voucher_gap',
    -- Stream 1 Phase 1: transaction reversal
    'uncategorize_transaction',
    -- Stream 1 Phase 1: supplier invoice lifecycle
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    -- Stream 1 Phase 1: invoice operations beyond simple create/send
    'credit_invoice',
    'convert_invoice',
    -- Phase 3: manual transaction ingestion + document attachment
    'create_transaction',
    'attach_document_to_transaction',
    -- Phase 4: arbitrary-line bookkeeping primitives
    'create_voucher',
    'correct_entry',
    'reverse_entry',
    -- Phase 5: supplier CRUD + inbox conversion
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    -- Bokslut: planenlig avskrivning (one journal entry per asset)
    'post_annual_depreciation',
    -- Link an existing posted verifikat as payment for an invoice (no new JE)
    'link_invoice_voucher'
  ));

-- Partial unique index: prevent linking the same voucher to the same invoice
-- twice while still allowing one voucher to settle multiple distinct invoices
-- (e.g. a single bank deposit covering several customer invoices). Mirrors the
-- existing idx_invoice_payments_tx_inv_unique pattern from
-- 20260323120001_invoice_partial_payments.sql.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payments_je_inv_unique
  ON public.invoice_payments (journal_entry_id, invoice_id)
  WHERE journal_entry_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
