-- Tighten transactions.document_id FK from ON DELETE SET NULL to RESTRICT.
--
-- The original definition (20260505140000) used SET NULL with the assumption
-- that block_document_deletion would catch any deletion of a propagated
-- document before the FK cascade fired. The compliance review flagged this as
-- fragile: trigger ordering could let a SET NULL slip through and silently
-- break the verifikation→underlag link (BFL 5 kap 6 §, 7 kap 1 §).
--
-- RESTRICT means a document with any pinned transaction cannot be deleted at
-- all — the user must explicitly detach first (which goes through the
-- application-layer + DB-level immutability guards). Belt-and-braces with
-- block_document_deletion.

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_document_id_fkey;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES public.document_attachments(id)
    ON DELETE RESTRICT;

NOTIFY pgrst, 'reload schema';
