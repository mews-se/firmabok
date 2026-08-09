-- Close the race in enforce_transactions_document_immutability:
-- the original trigger SELECT'd document_attachments.journal_entry_id without
-- a row lock, so a concurrent UPDATE on that row (e.g. the categorize
-- propagation setting journal_entry_id) could commit between the trigger's
-- SELECT and its RAISE, letting a detach through.
--
-- Acquire FOR SHARE on the document row inside the trigger so the trigger
-- either sees the post-UPDATE state and raises, or runs first and the
-- concurrent UPDATE waits on the share lock until our transaction completes.

CREATE OR REPLACE FUNCTION public.enforce_transactions_document_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_doc_je_id uuid;
BEGIN
  IF NEW.document_id IS NOT DISTINCT FROM OLD.document_id THEN
    RETURN NEW;
  END IF;

  IF OLD.document_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE: a concurrent UPDATE that wants to set journal_entry_id on the
  -- same row will block until our transaction commits. Either we observe the
  -- categorize propagation already-committed (and raise), or we hold the
  -- share lock and the propagation observes our committed detach (which is
  -- fine because at that point document.journal_entry_id was still null when
  -- our transaction began).
  SELECT journal_entry_id
    INTO old_doc_je_id
    FROM public.document_attachments
   WHERE id = OLD.document_id
   FOR SHARE;

  IF old_doc_je_id IS NOT NULL THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document % from transaction %: document is linked to journal entry % (BFL 5 kap 6 §).',
      OLD.document_id, OLD.id, old_doc_je_id;
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
