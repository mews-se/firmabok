-- Phase 4: expose the bookkeeping engine's arbitrary-line primitives via MCP.
--
-- Until now the only way to produce a journal entry via MCP was through a
-- preset workflow (categorize_transaction, create_invoice, ...). That blocks
-- legitimate flows the engine already supports — capitalization to balance-
-- sheet accounts (BAS 1010 development costs under K3), period-end accruals,
-- FX adjustments outside the built-in revaluation, prepayments, manual
-- reclassifications, and rättelseposter for foreign reverse-charge VAT.
--
-- Two new op types:
--   * create_voucher — arbitrary balanced lines via createJournalEntry()
--   * correct_entry  — storno + replacement via correctEntry() (BFL 5 kap 5§)
--
-- Both are routed as HIGH risk in lib/pending-operations/risk-tiers.ts because
-- they accept arbitrary account/amount/period inputs, unlike
-- uncategorize_transaction which mirrors an existing entry's shape.

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
    -- Phase 4: arbitrary-line bookkeeping primitives (this migration)
    'create_voucher',
    'correct_entry'
  ));

NOTIFY pgrst, 'reload schema';
