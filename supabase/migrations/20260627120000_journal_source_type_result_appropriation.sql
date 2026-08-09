-- Migration: add 'result_appropriation' to journal_entries.source_type CHECK
--
-- Year-end closing posts the net result to 2099 "Årets resultat", and the
-- opening-balance entry carries every class 1-2 account forward verbatim —
-- so 2099 was re-opened on 2099 each year and the prior result accumulated
-- there instead of being moved off "Årets resultat". The new
-- generateResultAppropriation() helper posts a separate year-open omföring
-- (Dr 2099 / Cr 2098 for a profit) in the new period so 2099 starts each
-- year at zero. That verifikat uses source_type='result_appropriation';
-- this migration adds the value to the DB allowlist so the insert is not
-- rejected with PG 23514. The TS type (JournalEntrySourceType) and the Zod
-- schema (JournalEntrySourceTypeSchema) are updated in the same change.
--
-- See 20260623120000 for the previous expansion pattern. We preserve all
-- pre-existing source_type values and append the new one.

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
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation'
  ));

NOTIFY pgrst, 'reload schema';
