-- Enforce "no bank transaction may point at an opening balance entry" from the
-- transactions side as well.
--
-- 20260723160000 made mark_entry_as_opening_balance refuse entries with linked
-- transactions, but that guard alone has a TOCTOU race: the RPC locks the
-- journal_entries row FOR UPDATE, while linking paths (e.g. manualLink in
-- lib/reconciliation/bank-reconciliation.ts) write transactions.journal_entry_id
-- without touching journal_entries. Under READ COMMITTED a link that commits
-- between the RPC's EXISTS check and its commit is invisible to the check, so an
-- entry could still end up retagged to opening_balance with a live transaction
-- pointing at it: the exact "permanent phantom difference" the guard exists to
-- prevent.
--
-- This trigger closes the race without touching the linking code paths: its
-- FOR KEY SHARE locking read on journal_entries conflicts with the RPC's
-- FOR UPDATE (and with nothing weaker, so ordinary entry updates are not
-- serialized against links).
--   * Link starts first: its FOR KEY SHARE blocks the RPC's FOR UPDATE until
--     the link commits; the RPC's EXISTS check then runs on a fresh snapshot
--     and refuses.
--   * Retag starts first: the trigger's FOR KEY SHARE blocks until the RPC
--     commits; the locking read then sees source_type = 'opening_balance' and
--     raises.
--
-- Fires only on INSERT with a non-NULL journal_entry_id and on UPDATEs that
-- actually change journal_entry_id to a non-NULL value: existing rows,
-- unlinks (SET NULL), and unrelated column updates are untouched.

CREATE OR REPLACE FUNCTION public.block_transaction_link_to_opening_balance()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER so RLS can never blind the invariant check (the linking
-- paths already enforce tenancy; this only READS source_type).
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_type text;
BEGIN
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  SELECT je.source_type INTO v_source_type
  FROM public.journal_entries je
  WHERE je.id = NEW.journal_entry_id
  FOR KEY SHARE;

  IF v_source_type = 'opening_balance' THEN
    RAISE EXCEPTION 'Cannot link a bank transaction to an opening balance entry (%): an ingaende balans predates the bank feed', NEW.journal_entry_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_transaction_link_not_opening_balance ON public.transactions;
CREATE TRIGGER check_transaction_link_not_opening_balance
  BEFORE INSERT OR UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_transaction_link_to_opening_balance();

NOTIFY pgrst, 'reload schema';
