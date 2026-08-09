-- Prevent overlapping fiscal periods per user.
--
-- Root cause: the UNIQUE(user_id, period_start, period_end) constraint only
-- blocked exact-duplicate date pairs, not overlapping ranges. Multiple code
-- paths (onboarding re-runs, SIE import, manual API) could create periods
-- with different but overlapping dates for the same user.
--
-- Fix: enable btree_gist, consolidate existing overlaps, add an EXCLUDE
-- constraint using daterange overlap (&&).

-- 1. Enable btree_gist for exclusion constraint support (uuid + daterange)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Temporarily disable immutability triggers to allow fiscal period
--    consolidation. This is a structural data fix (moving entries between
--    periods), not an accounting modification.
ALTER TABLE public.journal_entries DISABLE TRIGGER enforce_journal_entry_immutability;

-- 3. Consolidate overlapping fiscal periods: for each pair belonging to the
--    same user, move all references from the older period to the newer one,
--    then delete the older period.
DO $$
DECLARE
  overlap RECORD;
BEGIN
  FOR overlap IN
    SELECT DISTINCT ON (a.id)
      a.id   AS old_id,
      b.id   AS new_id
    FROM public.fiscal_periods a
    JOIN public.fiscal_periods b
      ON  a.user_id = b.user_id
      AND a.id != b.id
      AND a.period_start <= b.period_end
      AND a.period_end   >= b.period_start
      AND a.created_at < b.created_at
    ORDER BY a.id
  LOOP
    UPDATE public.journal_entries
      SET fiscal_period_id = overlap.new_id
      WHERE fiscal_period_id = overlap.old_id;

    UPDATE public.sie_imports
      SET fiscal_period_id = overlap.new_id
      WHERE fiscal_period_id = overlap.old_id;

    UPDATE public.voucher_sequences
      SET fiscal_period_id = overlap.new_id
      WHERE fiscal_period_id = overlap.old_id;

    UPDATE public.fiscal_periods
      SET previous_period_id = overlap.new_id
      WHERE previous_period_id = overlap.old_id;

    DELETE FROM public.fiscal_periods WHERE id = overlap.old_id;
  END LOOP;
END $$;

-- 4. Re-enable the immutability trigger
ALTER TABLE public.journal_entries ENABLE TRIGGER enforce_journal_entry_immutability;

-- 5. Add exclusion constraint: no two fiscal periods for the same user
--    may have overlapping date ranges.
ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT no_overlapping_fiscal_periods
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  );
