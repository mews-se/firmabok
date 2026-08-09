-- Make the immutability trigger's exception distinguishable from generic
-- check_violation (23514) failures. Compliance review noted that matching on
-- 23514 alone could mistakenly translate an unrelated future CHECK constraint
-- into the räkenskapsinformation message. Switch to RAISE EXCEPTION's default
-- SQLSTATE (P0001 / raise_exception) and prefix the message with a stable
-- application-defined tag the route handlers can match on.

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

  SELECT journal_entry_id
    INTO old_doc_je_id
    FROM public.document_attachments
   WHERE id = OLD.document_id;

  IF old_doc_je_id IS NOT NULL THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document % from transaction %: document is linked to journal entry % (BFL 5 kap 6 §).',
      OLD.document_id, OLD.id, old_doc_je_id;
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
