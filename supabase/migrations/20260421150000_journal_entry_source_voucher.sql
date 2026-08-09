-- Persist the original voucher identity (series + number) from an SIE source file
-- on each journal entry, for per-verifikat traceability from source system → gnubok.
--
-- Context: when the SIE importer skips an empty/single-line/unbalanced voucher,
-- subsequent vouchers end up with gnubok numbers that drift from the source
-- numbers. Today the source→target mapping lives only on
-- sie_imports.migration_documentation (JSONB array), so an individual
-- verifikat has no way to expose its original SIE id for search or display.
--
-- BFNAR 2013:2 kap 8 behandlingshistorik: a migration must preserve auditable
-- traceability. These columns denormalize the mapping onto each entry for
-- per-verifikat lookup without altering the aggregate JSONB audit record.
--
-- Scope: populated only by SIE import bulk insert (source_type='import'). Left
-- NULL for opening-balance and reconciliation entries (no single source VER),
-- and for all non-SIE sources (manual, invoice, bank, etc.).

ALTER TABLE public.journal_entries
  ADD COLUMN source_voucher_series TEXT,
  ADD COLUMN source_voucher_number INTEGER;

-- Index supports "find imported entry by original SIE number" lookups.
CREATE INDEX idx_journal_entries_source_voucher
  ON public.journal_entries (company_id, source_voucher_series, source_voucher_number)
  WHERE source_voucher_series IS NOT NULL;

-- Extend the immutability trigger to cover the new columns — matches the
-- pattern applied to commit_method/rubric_version in 20260420120000.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END; $$;

NOTIFY pgrst, 'reload schema';
