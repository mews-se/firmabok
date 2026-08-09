-- Expand pending_operations.operation_type to cover op types that were added
-- in TS (types/index.ts), wired into the risk-tier map and commit dispatcher,
-- but never added to the DB CHECK constraint:
--
--   * create_transaction          — manual transaction ingestion (e.g. Airtable import)
--   * attach_document_to_transaction — pin a receipt/invoice to a bank transaction
--
-- Without this, the MCP tools gnubok_create_transactions and
-- gnubok_attach_document_to_transaction fail at INSERT with a
-- check_violation on pending_operations_operation_type_check.

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
    'attach_document_to_transaction'
  ));

NOTIFY pgrst, 'reload schema';
