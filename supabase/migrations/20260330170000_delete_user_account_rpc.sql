-- RPC to safely delete a user account, bypassing protective triggers.
-- Triggers that enforce immutability / retention block ON DELETE CASCADE
-- from auth.users. This function temporarily disables them, lets CASCADE
-- clean up all public-schema data, then re-enables the triggers.
-- DDL in PostgreSQL is transactional, so on failure everything rolls back.

CREATE OR REPLACE FUNCTION public.delete_user_account(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only allow users to delete their own account
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  -- Disable BEFORE DELETE triggers that block deletion
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log DISABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments DISABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines DISABLE TRIGGER enforce_journal_entry_line_immutability;

  -- Disable AFTER DELETE audit triggers (they INSERT into audit_log during
  -- CASCADE, which would create orphaned rows after the user is gone)
  ALTER TABLE api_keys DISABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts DISABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings DISABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments DISABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data DISABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods DISABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries DISABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices DISABLE TRIGGER audit_supplier_invoices;

  -- Delete from auth.users — ON DELETE CASCADE handles all public tables
  DELETE FROM auth.users WHERE id = target_user_id;

  -- Re-enable all triggers
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log ENABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments ENABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines ENABLE TRIGGER enforce_journal_entry_line_immutability;
  ALTER TABLE api_keys ENABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts ENABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings ENABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments ENABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data ENABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods ENABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries ENABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices ENABLE TRIGGER audit_supplier_invoices;
END;
$$;
