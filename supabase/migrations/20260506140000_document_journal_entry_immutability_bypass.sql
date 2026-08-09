-- enforce_document_journal_entry_immutability (added in 20260506130000)
-- blocks any change to a non-null journal_entry_id once set. That is
-- correct for end-user paths but breaks delete_last_voucher: the RPC
-- legitimately needs to clear journal_entry_id before deleting a posted
-- voucher in a series (BFNAR 2013:2 permits removing the last voucher).
--
-- Bring this trigger in line with enforce_journal_entry_immutability,
-- which already honors a transaction-local gnubok.allow_delete=true bypass.
-- Only delete_last_voucher sets that flag, and only after enforcing all
-- legal constraints (last-in-series, no references, period not locked,
-- owner/admin). Outside the RPC the flag is unset, so end-user UPDATE
-- paths remain blocked.

CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.journal_entry_id IS NULL OR NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document % once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
