-- Add 'create_account', 'update_account' and 'set_voucher_note' to the
-- pending_operations operation_type CHECK.
--
-- create_account / update_account (gnubok_create_account /
-- gnubok_update_account): staged kontoplan reference-data writes. Risk tier
-- LOW (lib/pending-operations/risk-tiers.ts): no journal impact, no payment
-- routing, no external side-effects.
--
-- set_voucher_note (gnubok_set_voucher_note): notes-only annotation on a
-- verifikat. The journal_entries immutability trigger (20260608120000)
-- permits exactly a notes-only diff on committed entries, so the operation
-- cannot touch booking data. Risk tier LOW.
--
-- The list below is the union with 20260713121000 (previous expansion).
-- tests/pg/pending-operations-op-type-audit.pg.test.ts asserts every op type
-- staged in server.ts or tiered in risk-tiers.ts is accepted here.

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
    'create_article',
    'update_article',
    'bulk_book_inbox_items',
    'create_dimension_value',
    'retag_line_dimensions',
    'link_document_to_voucher',
    'update_payslip_line',
    'register_absence',
    'create_employee',
    'update_employee',
    'set_employee_opening_balances',
    'vacation_year_close',
    'create_account',                -- kontoplan: stage a new account
    'update_account',                -- kontoplan: stage rename/VAT-default/SRU/is_active edit
    'set_voucher_note'               -- verifikat annotation (notes-only, trigger-guarded)
  )) NOT VALID;

-- NOT VALID for the same reason as 20260713121000: no full-table scan under
-- ACCESS EXCLUSIVE. Validated in 20260717091000.

NOTIFY pgrst, 'reload schema';
