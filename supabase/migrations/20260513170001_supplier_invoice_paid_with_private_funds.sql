-- Migration: add paid_with_private_funds flag to supplier_invoices
--
-- Marks a supplier invoice / kvitto that the owner paid out-of-pocket with
-- private funds, so the company owes them back (eget utlägg).
--
-- When this flag is set at creation time the registration path bypasses the
-- normal AP (2440) leg entirely and books the expense directly against
-- shareholder/owner accounts:
--   AB  → credit 2893 (Skulder till närstående personer, kortfristig del)
--   EF  → credit 2018 (Övriga egna insättningar)
--
-- The invoice is created with status='paid' from the start; the regular
-- mark-paid flow stays unreachable for these rows (existing status guard in
-- /api/supplier-invoices/[id]/mark-paid already rejects status='paid').
--
-- BFL 5 kap verifikationskrav is unchanged — the invoice row still acts as
-- the underlying business document; only the journal-entry shape differs.
-- Retroactively flipping the flag on existing rows is not supported in v1
-- (the original AP journal entry is immutable per migration 017 trigger).

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS paid_with_private_funds boolean NOT NULL DEFAULT false;

-- Partial index: most invoices are AP-flow, only a minority are private
-- utlägg. The reports we'll likely build (e.g. "what does the company owe
-- the owner") need to find these fast.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_private_funds
  ON public.supplier_invoices (company_id, invoice_date)
  WHERE paid_with_private_funds = true;

-- Expand journal_entries.source_type CHECK to include the new entry type.
-- See 20260304075837 for the previous expansion pattern.
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid'
  ));

NOTIFY pgrst, 'reload schema';
