-- Belt-and-suspenders for the nullable invoice_number column.
-- Invoices in any status that implies they have left the draft stage must carry
-- a number. ensureInvoiceNumber covers known send paths in application code,
-- but a future caller could transition status without going through that helper
-- and silently produce a sent invoice with no löpnummer (ML 17 kap 24§ violation).
--
-- 'draft' and 'cancelled' are the only statuses where invoice_number may legally
-- be NULL — drafts have not been numbered yet, and cancelled-from-draft never
-- needed one. Cancelled-after-send retains its existing number, so the rule
-- still holds. Status enum from invoices_status_check:
--   draft, sent, paid, partially_paid, overdue, cancelled, credited

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sent_requires_number
  CHECK (status IN ('draft', 'cancelled') OR invoice_number IS NOT NULL);

NOTIFY pgrst, 'reload schema';
