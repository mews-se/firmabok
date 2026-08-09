-- ============================================================
-- clear-user-data.sql
-- Deletes ALL data for a given user from erp-base, including
-- the auth.users row. Handles circular FKs and temporarily
-- disables enforcement/audit triggers.
--
-- Usage:
--   1. Set the target email below
--   2. Run via Supabase SQL Editor or MCP execute_sql
-- ============================================================

-- Step 0: Look up the user ID (run this first to verify)
-- SELECT id, email FROM auth.users WHERE email = 'user@example.com';

DO $$
DECLARE
  -- >>> SET THE TARGET USER EMAIL HERE <<<
  target_email TEXT := 'user@example.com';  -- change this to the target user's email
  target_user_id UUID;
BEGIN
  -- Resolve email to user ID
  SELECT id INTO target_user_id FROM auth.users WHERE email = target_email;

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email: %', target_email;
  END IF;

  RAISE NOTICE 'Clearing all data for user % (%)', target_email, target_user_id;

  -- Disable all user-defined triggers (enforcement, audit, updated_at)
  -- Does NOT disable system FK triggers
  ALTER TABLE public.journal_entries DISABLE TRIGGER USER;
  ALTER TABLE public.journal_entry_lines DISABLE TRIGGER USER;
  ALTER TABLE public.document_attachments DISABLE TRIGGER USER;
  ALTER TABLE public.fiscal_periods DISABLE TRIGGER USER;
  ALTER TABLE public.transactions DISABLE TRIGGER USER;
  ALTER TABLE public.receipts DISABLE TRIGGER USER;
  ALTER TABLE public.invoices DISABLE TRIGGER USER;
  ALTER TABLE public.sie_imports DISABLE TRIGGER USER;
  ALTER TABLE public.cost_centers DISABLE TRIGGER USER;
  ALTER TABLE public.supplier_invoices DISABLE TRIGGER USER;
  ALTER TABLE public.customers DISABLE TRIGGER USER;
  ALTER TABLE public.suppliers DISABLE TRIGGER USER;
  ALTER TABLE public.chart_of_accounts DISABLE TRIGGER USER;
  ALTER TABLE public.audit_log DISABLE TRIGGER USER;
  ALTER TABLE public.company_settings DISABLE TRIGGER USER;
  ALTER TABLE public.profiles DISABLE TRIGGER USER;
  ALTER TABLE public.chat_sessions DISABLE TRIGGER USER;
  ALTER TABLE public.invoice_inbox_items DISABLE TRIGGER USER;

  -- Temporarily drop fiscal period constraints (migrations 042-043).
  -- The NOT VALID CHECK constraints are still enforced on UPDATE, so
  -- the circular-FK-breaking UPDATEs below will fail on rows with
  -- non-conforming dates. The EXCLUDE constraint can also interfere.
  -- We re-add them all after deletion.
  ALTER TABLE public.fiscal_periods DROP CONSTRAINT IF EXISTS no_overlapping_fiscal_periods;
  ALTER TABLE public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_period_start_first_of_month;
  ALTER TABLE public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_period_end_last_of_month;

  -- Break circular / self-referencing FK constraints
  UPDATE public.fiscal_periods SET closing_entry_id = NULL, opening_balance_entry_id = NULL, previous_period_id = NULL WHERE user_id = target_user_id;
  UPDATE public.transactions SET receipt_id = NULL, journal_entry_id = NULL, invoice_id = NULL, potential_invoice_id = NULL, supplier_invoice_id = NULL, bank_connection_id = NULL WHERE user_id = target_user_id;
  UPDATE public.receipts SET matched_transaction_id = NULL, document_id = NULL WHERE user_id = target_user_id;
  UPDATE public.invoices SET credited_invoice_id = NULL, converted_from_id = NULL WHERE user_id = target_user_id;
  UPDATE public.document_attachments SET original_id = NULL, superseded_by_id = NULL, journal_entry_id = NULL, journal_entry_line_id = NULL WHERE user_id = target_user_id;
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL, fiscal_period_id = NULL WHERE user_id = target_user_id;
  UPDATE public.cost_centers SET parent_id = NULL WHERE user_id = target_user_id;

  -- Delete child/leaf tables first, then parent tables
  DELETE FROM public.receipt_line_items WHERE receipt_id IN (SELECT id FROM public.receipts WHERE user_id = target_user_id);
  DELETE FROM public.invoice_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE user_id = target_user_id);
  DELETE FROM public.invoice_reminders WHERE user_id = target_user_id;
  DELETE FROM public.supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM public.supplier_invoices WHERE user_id = target_user_id);
  DELETE FROM public.supplier_invoice_payments WHERE supplier_invoice_id IN (SELECT id FROM public.supplier_invoices WHERE user_id = target_user_id);
  DELETE FROM public.invoice_inbox_items WHERE user_id = target_user_id;
  DELETE FROM public.document_attachments WHERE user_id = target_user_id;
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM public.journal_entries WHERE user_id = target_user_id);
  DELETE FROM public.journal_entries WHERE user_id = target_user_id;
  DELETE FROM public.receipts WHERE user_id = target_user_id;
  DELETE FROM public.transactions WHERE user_id = target_user_id;
  DELETE FROM public.invoices WHERE user_id = target_user_id;
  DELETE FROM public.supplier_invoices WHERE user_id = target_user_id;
  DELETE FROM public.suppliers WHERE user_id = target_user_id;
  DELETE FROM public.customers WHERE user_id = target_user_id;
  DELETE FROM public.sie_imports WHERE user_id = target_user_id;
  DELETE FROM public.sie_account_mappings WHERE user_id = target_user_id;
  DELETE FROM public.voucher_sequences WHERE user_id = target_user_id;
  DELETE FROM public.fiscal_periods WHERE user_id = target_user_id;
  DELETE FROM public.chart_of_accounts WHERE user_id = target_user_id;
  DELETE FROM public.bank_connections WHERE user_id = target_user_id;
  DELETE FROM public.mapping_rules WHERE user_id = target_user_id;
  DELETE FROM public.deadlines WHERE user_id = target_user_id;
  DELETE FROM public.calendar_feeds WHERE user_id = target_user_id;
  DELETE FROM public.push_subscriptions WHERE user_id = target_user_id;
  DELETE FROM public.notification_log WHERE user_id = target_user_id;
  DELETE FROM public.notification_settings WHERE user_id = target_user_id;
  DELETE FROM public.cost_centers WHERE user_id = target_user_id;
  DELETE FROM public.projects WHERE user_id = target_user_id;
  DELETE FROM public.bank_file_imports WHERE user_id = target_user_id;
  DELETE FROM public.chat_messages WHERE user_id = target_user_id;
  DELETE FROM public.chat_sessions WHERE user_id = target_user_id;
  DELETE FROM public.extension_data WHERE user_id = target_user_id;
  DELETE FROM public.audit_log WHERE user_id = target_user_id;
  DELETE FROM public.company_settings WHERE user_id = target_user_id;
  DELETE FROM public.profiles WHERE id = target_user_id;

  -- Re-enable all user-defined triggers
  ALTER TABLE public.journal_entries ENABLE TRIGGER USER;
  ALTER TABLE public.journal_entry_lines ENABLE TRIGGER USER;
  ALTER TABLE public.document_attachments ENABLE TRIGGER USER;
  ALTER TABLE public.fiscal_periods ENABLE TRIGGER USER;
  ALTER TABLE public.transactions ENABLE TRIGGER USER;
  ALTER TABLE public.receipts ENABLE TRIGGER USER;
  ALTER TABLE public.invoices ENABLE TRIGGER USER;
  ALTER TABLE public.sie_imports ENABLE TRIGGER USER;
  ALTER TABLE public.cost_centers ENABLE TRIGGER USER;
  ALTER TABLE public.supplier_invoices ENABLE TRIGGER USER;
  ALTER TABLE public.customers ENABLE TRIGGER USER;
  ALTER TABLE public.suppliers ENABLE TRIGGER USER;
  ALTER TABLE public.chart_of_accounts ENABLE TRIGGER USER;
  ALTER TABLE public.audit_log ENABLE TRIGGER USER;
  ALTER TABLE public.company_settings ENABLE TRIGGER USER;
  ALTER TABLE public.profiles ENABLE TRIGGER USER;
  ALTER TABLE public.chat_sessions ENABLE TRIGGER USER;
  ALTER TABLE public.invoice_inbox_items ENABLE TRIGGER USER;

  -- Re-add fiscal period constraints
  ALTER TABLE public.fiscal_periods
    ADD CONSTRAINT no_overlapping_fiscal_periods
    EXCLUDE USING gist (
      user_id WITH =,
      daterange(period_start, period_end, '[]') WITH &&
    );

  ALTER TABLE public.fiscal_periods
    ADD CONSTRAINT fiscal_period_start_first_of_month
    CHECK (EXTRACT(DAY FROM period_start) = 1)
    NOT VALID;

  ALTER TABLE public.fiscal_periods
    ADD CONSTRAINT fiscal_period_end_last_of_month
    CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date)
    NOT VALID;

  -- Delete the auth user
  DELETE FROM auth.users WHERE id = target_user_id;

  RAISE NOTICE 'Done. User % and all associated data have been deleted.', target_email;
END $$;
