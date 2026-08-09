-- Migration: add 'inbox_item' to journal_entries.source_type CHECK constraint
--
-- The `/api/extensions/ext/invoice-inbox/items/:id/book-direct` route uses
-- source_type='inbox_item' when booking a standalone verifikation from the
-- document inbox (no bank-transaction link). The TS type
-- (JournalEntrySourceType in types/index.ts) and the Zod schema
-- (JournalEntrySourceTypeSchema in lib/api/schemas.ts) already list it, but
-- the DB CHECK constraint was never updated -- so every "Bokför direkt"
-- without a linked transaction failed with PG 23514, surfaced as the generic
-- "Verifikationen kunde inte sparas. Försök igen." error.
--
-- See 20260513170001 for the previous expansion pattern.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid'
  ));

NOTIFY pgrst, 'reload schema';
