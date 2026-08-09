-- Backfill `submit_vat_declaration` and `submit_agi` into the
-- pending_operations.operation_type CHECK constraint.
--
-- PR5 of the agent-first P0 set wraps the existing Skatteverket extension as
-- five MCP tools. The two high-risk submit tools (gnubok_vat_declaration_submit
-- and gnubok_agi_submit) stage a pending operation that, on approval, dispatches
-- into the skatteverket extension's commit services (commitSubmitVatDeclaration /
-- commitSubmitAgi) and returns a BankID signing link. "Commit" here means
-- "send for signing", not "file" — the irreversible act is the user's BankID
-- signature in the browser. Both ops carry a risk-tier entry ('high', external
-- and irreversible once signed).
--
-- Without this migration any INSERT staged by the new submit tools would be
-- rejected with a constraint violation before the commit-side code ever runs,
-- blocking the staged-operation review flow.
--
-- pg-test: covered-by — this is a CHECK-list expansion only (no trigger/RPC/
-- RLS/DEFERRABLE change), so no *.pg.test.ts is required.

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'run_currency_revaluation',
    'import_sie',
    'explain_voucher_gap',
    'uncategorize_transaction',
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    'credit_invoice',
    'convert_invoice',
    'create_transaction',
    'attach_document_to_transaction',
    'create_voucher',
    'correct_entry',
    'reverse_entry',
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    'post_annual_depreciation',
    'link_invoice_voucher',
    'undo_sie_import',
    'match_batch_allocate',
    'bulk_book_transactions',
    'create_salary_run',
    'generate_agi',
    'link_transaction_journal_entry',
    'link_supplier_invoice_voucher',
    'submit_vat_declaration',  -- Skatteverket momsdeklaration → BankID signing link
    'submit_agi'               -- Skatteverket arbetsgivardeklaration → BankID signing link
  ));

NOTIFY pgrst, 'reload schema';
