-- Document-level linking never resolved the inbox row. An inbox item counts
-- as handled once a terminal-link pointer is set (created_supplier_invoice_id,
-- created_journal_entry_id, matched_transaction_id), but attaching the item's
-- DOCUMENT to an existing verifikat (koppla-till-verifikat, MCP
-- link_document_to_voucher, invoice/supplier-invoice booking) only writes
-- document_attachments.journal_entry_id — the inbox row stayed "att hantera"
-- forever. The one mitigation, POST /api/documents/[id]/link stamping
-- created_journal_entry_id when the client passed inbox_item_id, breaks on the
-- second document linked to the same verifikat: the UNIQUE constraint from
-- 20260515090000 (required by the book-direct race guard) rejects the stamp.
--
-- Fix: a dedicated non-unique pointer, kept in sync by a trigger on
-- document_attachments.journal_entry_id so the stamp is atomic with the
-- document link itself (no best-effort UPDATE for a handler to swallow, the
-- failure mode behind the earlier status='confirmed' bug). The trigger also
-- clears the pointer when a document is detached under the gnubok.allow_delete
-- carve-out (delete/direct-edit RPCs), returning the row to the active inbox.
--
--   created_journal_entry_id  = the inbox item produced that verifikat
--   linked_journal_entry_id   = the item's document was attached to one

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN linked_journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Reverse lookup (verifikat -> inbox provenance), mirroring the
-- created_journal_entry_id index from 20260514120000.
CREATE INDEX idx_invoice_inbox_items_linked_je
  ON public.invoice_inbox_items(company_id, linked_journal_entry_id)
  WHERE linked_journal_entry_id IS NOT NULL;

-- SECURITY DEFINER: the sync must land even when the document write comes
-- from a client whose RLS view of invoice_inbox_items would silently skip
-- the row. Company equality is enforced explicitly instead.
CREATE OR REPLACE FUNCTION public.sync_inbox_linked_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.invoice_inbox_items
     SET linked_journal_entry_id = NEW.journal_entry_id
   WHERE document_id = NEW.id
     AND company_id = NEW.company_id
     AND linked_journal_entry_id IS DISTINCT FROM NEW.journal_entry_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_inbox_linked_journal_entry
  AFTER UPDATE OF journal_entry_id ON public.document_attachments
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id)
  EXECUTE FUNCTION public.sync_inbox_linked_journal_entry();

-- Backfill: rows whose document already reached a verifikat (archived and
-- linked, yet still listed as unhandled).
UPDATE public.invoice_inbox_items i
   SET linked_journal_entry_id = d.journal_entry_id
  FROM public.document_attachments d
 WHERE d.id = i.document_id
   AND d.journal_entry_id IS NOT NULL
   AND i.linked_journal_entry_id IS NULL;

NOTIFY pgrst, 'reload schema';
