-- Migration: backfill invoices.journal_entry_id (registration entry linkage)
--
-- The column (added in 20260613100000_self_billing_received_invoices.sql)
-- means "the verifikat that BOOKED this invoice at issuance" — the
-- invoice_created registration entry (Dr 1510 / Cr 30xx+26xx), or the
-- credit_note reversal entry on a credit-note row. Payment flows route on it:
-- set → clearing entry (Dr 1930 / Cr 1510); NULL → kontantmetoden cash entry
-- (Dr 1930 / Cr 30xx+26xx). Write-backs only shipped ~2026-06-05, so nearly
-- all historical rows are NULL even where a posted registration entry exists —
-- a company on (or switching to) kontantmetoden would double-book revenue +
-- VAT when marking those invoices paid.
--
-- Passes 1–2 touch ONLY rows that are still NULL, so the migration is
-- idempotent and safe to re-run / resume after an interruption. Rows with no
-- posted registration entry stay NULL — that is the CORRECT value for
-- kontantmetoden / unsent / proforma invoices (revenue is recognised at
-- payment instead).

-- Pass 0 — defensive repair. An earlier version of the v1 mark-paid route
-- wrote the PAYMENT/cash entry id into this column (wrong semantic: it would
-- make a kontantmetoden invoice look registered, so a later partial payment
-- clears a 1510 that was never debited). Hosted prod has no such rows, but
-- self-hosted databases that ran that code may. Null them out so Pass 1 can
-- re-link the correct registration entry where one exists.
UPDATE public.invoices i
SET journal_entry_id = NULL
FROM public.journal_entries je
WHERE je.id = i.journal_entry_id
  AND je.source_type IN ('invoice_paid', 'invoice_cash_payment');

-- Pass 1 — registration entries. Earliest posted invoice_created entry per
-- invoice; status='posted' excludes reversed/cancelled/draft (a stornoed
-- registration must not mark the invoice as booked). DISTINCT ON with the
-- created_at,id ordering gives a deterministic pick if duplicates exist.
-- The company_id equality guard is defense-in-depth against cross-tenant
-- uuid collisions. idx_journal_entries_source (source_type, source_id) makes
-- the subquery cheap.
UPDATE public.invoices i
SET journal_entry_id = je.id
FROM (
  SELECT DISTINCT ON (company_id, source_id) id, company_id, source_id
  FROM public.journal_entries
  WHERE source_type = 'invoice_created'
    AND status = 'posted'
    AND source_id IS NOT NULL
  ORDER BY company_id, source_id, created_at ASC, id ASC
) je
WHERE i.journal_entry_id IS NULL
  AND je.source_id = i.id
  AND je.company_id = i.company_id;

-- Pass 2 — credit-note reversal entries onto credit-note rows
-- (source_type='credit_note', source_id = the credit note's own invoice row
-- id; matches the live write sites: v1 credit route, app/api/invoices POST).
-- Payment routing never reads these (mark-paid rejects credit notes) — this
-- pass exists for the dashboard verifikat link and linkage completeness.
UPDATE public.invoices i
SET journal_entry_id = je.id
FROM (
  SELECT DISTINCT ON (company_id, source_id) id, company_id, source_id
  FROM public.journal_entries
  WHERE source_type = 'credit_note'
    AND status = 'posted'
    AND source_id IS NOT NULL
  ORDER BY company_id, source_id, created_at ASC, id ASC
) je
WHERE i.journal_entry_id IS NULL
  AND i.credited_invoice_id IS NOT NULL
  AND je.source_id = i.id
  AND je.company_id = i.company_id;

NOTIFY pgrst, 'reload schema';
