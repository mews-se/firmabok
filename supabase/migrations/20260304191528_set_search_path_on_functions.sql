-- Security hardening: pin search_path on all custom functions
-- to prevent search_path injection attacks.
-- See: https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable

ALTER FUNCTION public.audit_log_immutable() SET search_path = public;
ALTER FUNCTION public.block_document_deletion() SET search_path = public;
ALTER FUNCTION public.calculate_retention_expiry() SET search_path = public;
ALTER FUNCTION public.check_journal_entry_balance() SET search_path = public;
-- create_invoice_with_items removed: function was never created
ALTER FUNCTION public.detect_voucher_gaps(p_user_id uuid, p_fiscal_period_id uuid, p_series text) SET search_path = public;
ALTER FUNCTION public.enforce_journal_entry_immutability() SET search_path = public;
ALTER FUNCTION public.enforce_journal_entry_line_immutability() SET search_path = public;
ALTER FUNCTION public.enforce_opening_balance_immutability() SET search_path = public;
ALTER FUNCTION public.enforce_period_lock() SET search_path = public;
ALTER FUNCTION public.enforce_period_lock_documents() SET search_path = public;
ALTER FUNCTION public.enforce_retention_journal_entries() SET search_path = public;
-- generate_invoice_number removed: created in later migration (20260306) with search_path already set
ALTER FUNCTION public.get_next_arrival_number(p_user_id uuid) SET search_path = public;
ALTER FUNCTION public.get_unlinked_1930_lines(p_user_id uuid, p_date_from date, p_date_to date) SET search_path = public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;
ALTER FUNCTION public.next_voucher_number(p_user_id uuid, p_fiscal_period_id uuid, p_series text) SET search_path = public;
-- seed_asset_categories removed: function was never created
ALTER FUNCTION public.seed_chart_of_accounts(p_user_id uuid, p_entity_type text) SET search_path = public;
ALTER FUNCTION public.set_committed_at() SET search_path = public;
ALTER FUNCTION public.update_overdue_supplier_invoices() SET search_path = public;
-- update_reconciliation_session_counts removed: function was never created
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;
ALTER FUNCTION public.write_audit_log() SET search_path = public;
