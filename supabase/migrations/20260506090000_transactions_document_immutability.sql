-- BFL 5 kap 6 § / 7 kap 1 §: once a document has propagated to a journal
-- entry (i.e. become räkenskapsinformation underlag), the link from the
-- transaction to that document must not be silently broken. The application-
-- layer guard in /api/transactions/[id]/attach-document gives the user a
-- friendly Swedish error; this trigger is the DB-level safety net that also
-- catches direct SQL writes, races, and the FK SET NULL path.

CREATE OR REPLACE FUNCTION public.enforce_transactions_document_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_doc_je_id uuid;
BEGIN
  -- Only act when document_id changes.
  IF NEW.document_id IS NOT DISTINCT FROM OLD.document_id THEN
    RETURN NEW;
  END IF;

  -- No previously-attached document, nothing to protect.
  IF OLD.document_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- If the previously-attached document is already räkenskapsinformation
  -- (linked to a journal entry), block the change. Storno the journal entry
  -- first if you genuinely need to swap or detach.
  SELECT journal_entry_id
    INTO old_doc_je_id
    FROM public.document_attachments
   WHERE id = OLD.document_id;

  IF old_doc_je_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot detach or swap document % from transaction %: document is linked to journal entry % and is räkenskapsinformation per BFL 5 kap 6 §. Reverse the journal entry first.',
      OLD.document_id, OLD.id, old_doc_je_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_transactions_document_immutability ON public.transactions;
CREATE TRIGGER enforce_transactions_document_immutability
  BEFORE UPDATE OF document_id ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_transactions_document_immutability();

NOTIFY pgrst, 'reload schema';
