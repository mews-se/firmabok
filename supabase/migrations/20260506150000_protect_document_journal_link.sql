-- Closes BFL 7 kap 2§ retention bypass on document_attachments.
--
-- Problem: enforce_document_metadata_immutability protected file identity
-- columns but not journal_entry_id / journal_entry_line_id. block_document_deletion
-- only fires when OLD.journal_entry_id IS NOT NULL. An attacker could therefore
-- run UPDATE document_attachments SET journal_entry_id = NULL WHERE id = X,
-- followed by DELETE FROM document_attachments WHERE id = X, severing
-- räkenskapsinformation from the audit trail in violation of BFL 7 kap 2§.
--
-- Fix: extend the existing immutability trigger to also reject changes to
-- journal_entry_id and journal_entry_line_id when the document is currently
-- linked to a posted or reversed journal entry. Honour the existing
-- gnubok.allow_delete transaction-local bypass that delete_last_voucher uses
-- when intentionally tearing down a voucher.

CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_entry_status
  FROM public.journal_entries
  WHERE id = OLD.journal_entry_id;

  IF v_entry_status IS NULL OR v_entry_status NOT IN ('posted', 'reversed') THEN
    RETURN NEW;
  END IF;

  IF NEW.file_name              IS DISTINCT FROM OLD.file_name
     OR NEW.storage_path        IS DISTINCT FROM OLD.storage_path
     OR NEW.file_size_bytes     IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.mime_type           IS DISTINCT FROM OLD.mime_type
     OR NEW.sha256_hash         IS DISTINCT FROM OLD.sha256_hash
     OR NEW.upload_source       IS DISTINCT FROM OLD.upload_source
     OR NEW.digitization_date   IS DISTINCT FROM OLD.digitization_date
     OR NEW.uploaded_by         IS DISTINCT FROM OLD.uploaded_by
     OR NEW.version             IS DISTINCT FROM OLD.version
     OR NEW.original_id         IS DISTINCT FROM OLD.original_id
     OR NEW.is_current_version  IS DISTINCT FROM OLD.is_current_version
     OR NEW.journal_entry_id    IS DISTINCT FROM OLD.journal_entry_id
     OR NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id
  THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id,
      'Blocked metadata or link modification of document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify metadata or journal entry link of document linked to a % journal entry (BFL 7 kap)', v_entry_status;
  END IF;

  RETURN NEW;
END;
$function$;
