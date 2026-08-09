-- Tighten replace_period_opening_balance_link to owner/admin only.
--
-- 20260528120200_replace_period_opening_balance_link.sql initially allowed
-- 'member' alongside 'owner'/'admin'. That was inconsistent with the peer
-- recovery RPCs (delete_last_voucher, undo_sie_import), which both restrict
-- this kind of structural mutation to owner/admin. Tighten here so the
-- whole recovery surface uses the same role gate.

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

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Insufficient role to relink opening balance';
  END IF;

  PERFORM 1
  FROM journal_entries
  WHERE id = p_new_entry_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_period_id
    AND status = 'posted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'New opening balance entry % is not a posted entry in period %', p_new_entry_id, p_period_id;
  END IF;

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
