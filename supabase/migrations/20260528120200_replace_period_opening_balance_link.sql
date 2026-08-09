-- Atomic relink of fiscal_periods.opening_balance_entry_id.
--
-- Used by the pragmatic IB resync flow in lib/import/sie-import.ts when
-- importing a prior fiscal year retroactively. The next period's IB
-- (already created from a prior import or manual entry) gets stornoed and
-- replaced with the new IB derived from the just-imported year's #UB —
-- so the chain stays consistent without forcing the user to drop and
-- reimport the later year.
--
-- enforce_opening_balance_immutability blocks any UPDATE that changes
-- opening_balance_entry_id while opening_balances_set is true. The
-- canonical workaround is to flip opening_balances_set to false in one
-- statement and change the FK in another (the trigger reads OLD on each
-- UPDATE). Doing this in a single transaction-level RPC keeps the period
-- from being observable in an unset state by concurrent queries.

CREATE OR REPLACE FUNCTION public.replace_period_opening_balance_link(
  p_company_id uuid,
  p_period_id uuid,
  p_new_entry_id uuid
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Insufficient role to relink opening balance';
  END IF;

  -- Sanity: the new entry must exist, be posted, and belong to the same
  -- company and period as the link target.
  PERFORM 1
  FROM journal_entries
  WHERE id = p_new_entry_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_period_id
    AND status = 'posted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'New opening balance entry % is not a posted entry in period %', p_new_entry_id, p_period_id;
  END IF;

  -- Two-step around enforce_opening_balance_immutability: the trigger
  -- only raises when OLD.opening_balances_set = true AND the FK is being
  -- changed in the same statement. Flip the flag first, then change the
  -- FK and flip the flag back on.
  UPDATE fiscal_periods
  SET opening_balances_set = false
  WHERE id = p_period_id
    AND company_id = p_company_id;

  UPDATE fiscal_periods
  SET opening_balance_entry_id = p_new_entry_id,
      opening_balances_set     = true
  WHERE id = p_period_id
    AND company_id = p_company_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
