-- Allow delete_last_voucher RPC to delete draft entries.
--
-- Background: createJournalEntry does createDraft + commit atomically. If
-- commit fails the orphan draft is now cancelled (commit 28df5d85), but
-- legacy drafts created before that fix remain stuck — the previous RPC
-- only accepted status='posted'. There is no UI path to remove them.
--
-- Drafts are not part of the verifikationsserie (voucher_number = 0,
-- never assigned a sequence number) and are not bokförda under BFL.
-- Deletion of a draft does not affect the audit trail and does not
-- require the same protections as posted entries.
--
-- For drafts we skip:
--   * last-in-series check (drafts have no number)
--   * voucher_sequences row update (no number was issued)
--   * reverses_id un-reversal (drafts cannot be reversed)
--   * fiscal-period closed/locked check (drafts are not posted)
--
-- We keep:
--   * owner/admin role gate
--   * audit_log entry
--   * gnubok.allow_delete flag so the line-immutability trigger lets
--     the cascade delete its rows
--
-- For posted entries the existing logic is unchanged.

CREATE OR REPLACE FUNCTION public.delete_last_voucher(p_company_id uuid, p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry            record;
  v_period           record;
  v_max_voucher      integer;
  v_ref_count        integer;
  v_caller_role      text;
  v_snapshot         jsonb;
  v_lines_snapshot   jsonb;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status NOT IN ('posted', 'draft') THEN
    RAISE EXCEPTION 'Only posted or draft entries can be deleted (current status: %)', v_entry.status;
  END IF;

  -- Snapshot for audit log (same shape for draft and posted)
  SELECT jsonb_agg(to_jsonb(l)) INTO v_lines_snapshot
  FROM journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := to_jsonb(v_entry) || jsonb_build_object('lines', COALESCE(v_lines_snapshot, '[]'::jsonb));

  -- Draft path: simplified deletion (no series, no period checks needed)
  IF v_entry.status = 'draft' THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);

    UPDATE document_attachments
    SET journal_entry_id = NULL
    WHERE journal_entry_id = p_entry_id;

    DELETE FROM journal_entries WHERE id = p_entry_id;

    INSERT INTO audit_log (user_id, action, table_name, record_id, actor_id, old_state, description)
    VALUES (
      v_entry.user_id,
      'DELETE',
      'journal_entries',
      p_entry_id,
      auth.uid(),
      v_snapshot,
      'Deleted draft journal entry (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
    );

    RETURN jsonb_build_object(
      'deleted', true,
      'voucher_series', v_entry.voucher_series,
      'voucher_number', v_entry.voucher_number,
      'was_draft', true
    );
  END IF;

  -- Posted path: existing logic unchanged
  SELECT * INTO v_period
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id
  FOR UPDATE;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'Cannot delete voucher in a closed fiscal period';
  END IF;

  IF v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete voucher in a locked fiscal period';
  END IF;

  PERFORM 1 FROM voucher_sequences
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
  FOR UPDATE;

  SELECT MAX(voucher_number) INTO v_max_voucher
  FROM journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
    AND status NOT IN ('cancelled', 'draft');

  IF v_entry.voucher_number != v_max_voucher THEN
    RAISE EXCEPTION 'Kan bara radera det sista verifikatet i serien. % har nummer % men senaste är %',
      v_entry.voucher_series, v_entry.voucher_number, v_max_voucher;
  END IF;

  SELECT COUNT(*) INTO v_ref_count
  FROM journal_entries
  WHERE company_id = p_company_id
    AND status != 'cancelled'
    AND (reverses_id = p_entry_id OR correction_of_id = p_entry_id);

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete: other entries reference this voucher (% references)',
      v_ref_count;
  END IF;

  IF v_entry.reverses_id IS NOT NULL THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);
    UPDATE journal_entries
    SET status = 'posted', reversed_by_id = NULL
    WHERE id = v_entry.reverses_id
      AND company_id = p_company_id;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM journal_entries WHERE id = p_entry_id;

  UPDATE voucher_sequences
  SET last_number = GREATEST(last_number - 1, 0)
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series;

  INSERT INTO audit_log (user_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_entry.user_id,
    'DELETE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    v_snapshot,
    'Deleted voucher ' || v_entry.voucher_series || v_entry.voucher_number ||
    ' (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
