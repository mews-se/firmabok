-- Fix: enforce_journal_entry_immutability blocks DELETE and the
-- reversed → posted "un-reversal" UPDATE that delete_last_voucher RPC needs
-- when removing a storno entry. The RPC sets gnubok.allow_delete, but the
-- trigger blocks both operations unconditionally. Result: the RPC fails,
-- even though BFNAR 2013:2 explicitly permits deletion of the last voucher
-- in a series.
--
-- enforce_journal_entry_line_immutability already respects this flag;
-- this migration brings the entries trigger in line — but narrowly.
--
-- Bypass scope:
--   * DELETE: allowed when gnubok.allow_delete='true'. delete_last_voucher
--     enforces all legal constraints (last-in-series, no references, period
--     not locked, owner/admin) before setting the flag.
--   * UPDATE: allowed only for the specific reversed → posted transition
--     used to "un-reverse" the original entry when its storno is being
--     deleted. All other UPDATE paths still go through the normal state
--     machine — defense-in-depth on posted-entry mutation is preserved.

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
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

  -- Narrow un-reversal path: when delete_last_voucher removes a storno entry,
  -- it flips the original from 'reversed' back to 'posted'. No other fields
  -- may change, and the bypass flag must be set.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;
