-- BFL compliance: replace hard-delete of uncredited credit notes with a soft-delete
-- status so that the row, its items, and its back-reference from the posted JE all
-- survive. BFL 7 kap requires räkenskapsinformation to be preserved in an unalterable
-- form for 7 years; BFL 5 kap 7§ implies ankomstnummer should be an unbroken series;
-- sambandskravet (BFL 4 kap 2§) requires verifikationer to remain traceable back to
-- their underlag. Hard-deleting the supplier_invoices row would break all three.
--
-- This migration mirrors the pattern used for journal_entries in
-- 20260319000001_add_cancelled_journal_status.sql.

-- 1. Expand status CHECK to include 'reversed'.
ALTER TABLE public.supplier_invoices
  DROP CONSTRAINT IF EXISTS supplier_invoices_status_check;
ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_status_check
  CHECK (status IN (
    'registered',
    'approved',
    'paid',
    'partially_paid',
    'overdue',
    'disputed',
    'credited',
    'reversed'
  ));

-- 2. Add reversed_at timestamp for audit — when a credit note was storno-reversed.
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.supplier_invoices.reversed_at IS
  'Timestamp when a credit note was reversed via "Ångra kreditering". Pairs with status=''reversed''. Row itself is retained for BFL 7 kap compliance.';

-- 3. Widen the partial unique index to exclude both 'credited' and 'reversed'.
--
-- Baseline (migration 20260330130000): UNIQUE on (company_id, supplier_id,
-- supplier_invoice_number) WHERE supplier_invoice_number IS NOT NULL. A credited
-- original kept its row under the original number, blocking any re-entry of a
-- corrected invoice under the same number (Postgres 23505 -> HTTP 500 with no
-- recovery path). That breaks a common Swedish accounting pattern: a supplier
-- re-issues a corrected invoice under the same löpnummer.
--
-- With this migration: 'credited' originals and 'reversed' (uncredited) credit
-- notes both drop out of the uniqueness check. The credit note itself carries
-- a "KREDIT-" prefixed number so it never collides with the original either way.
-- The credited original and the reversed credit row both remain in the table
-- for BFL 7 kap audit purposes; only the number slot is freed.
DROP INDEX IF EXISTS public.idx_supplier_invoices_company_supplier_number;

CREATE UNIQUE INDEX idx_supplier_invoices_company_supplier_number
  ON public.supplier_invoices (company_id, supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL
    AND status NOT IN ('credited', 'reversed');

NOTIFY pgrst, 'reload schema';
