-- BFL 7 kap räkenskapsinformation immutability is bidirectional: once a
-- document_attachments row's journal_entry_id has been set (the doc is now
-- the underlag for a verifikation), nothing should be able to clear it back
-- to NULL. The transactions-side immutability trigger added in 20260506090000
-- prevents transactions.document_id from being detached, but a direct UPDATE
-- on document_attachments could still null out journal_entry_id.
--
-- Add a parallel trigger on document_attachments that blocks UPDATE that
-- would null out a non-null journal_entry_id. Keeping this distinct from
-- existing triggers so block_document_deletion (DELETE-side) and this
-- (UPDATE-side) are independent guards.

CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only act when journal_entry_id changes.
  IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  -- Allow first-time set (NULL → uuid).
  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Block clearing or swapping once set: BFL 5 kap 6 § requires the
  -- verifikation→underlag link to be durable.
  IF NEW.journal_entry_id IS NULL OR NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document % once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_document_journal_entry_immutability ON public.document_attachments;
CREATE TRIGGER enforce_document_journal_entry_immutability
  BEFORE UPDATE OF journal_entry_id ON public.document_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_document_journal_entry_immutability();

NOTIFY pgrst, 'reload schema';
