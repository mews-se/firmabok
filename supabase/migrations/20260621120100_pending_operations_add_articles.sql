-- Add 'create_article' and 'update_article' to the pending_operations
-- operation_type CHECK constraint.
--
-- The artikelregister MCP tools (gnubok_create_article / gnubok_update_article)
-- stage a pending operation that, on approval, dispatches into commitCreateArticle
-- / commitUpdateArticle. Without this expansion the staged INSERT would be
-- rejected by the constraint before the commit-side code ever runs, blocking the
-- staged-operation review flow — mirrors create_customer / create_supplier.
--
-- pg-test: covered-by — CHECK-list expansion only (no trigger/RPC/RLS/DEFERRABLE
-- change), so no *.pg.test.ts is required.

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
    'submit_vat_declaration',
    'submit_agi',
    'create_article',  -- artikelregister: stage a new catalog article
    'update_article'   -- artikelregister: stage an edit / deactivate
  ));

NOTIFY pgrst, 'reload schema';
