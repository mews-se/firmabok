-- Migration: make get_account_gl_lines_for_matching count links per settlement
-- account instead of per voucher (issue #1026).
--
-- An own-account transfer books ONE verifikat touching two cash accounts
-- (e.g. credit 1940, debit 1930) while the bank feed delivers TWO transactions,
-- one per account. Once the outgoing leg is matched, the voucher counted as
-- "already matched" for every account, so the incoming leg's match dialog hid
-- it behind the "Visa även matchade verifikationer" opt-in. From the incoming
-- account's point of view the voucher is genuinely unmatched: its 1930 line has
-- no transaction settling it. Users read the empty default list as "the app
-- won't let me link this" (support case: two transfer legs stuck for a week).
--
-- Fix: linked_transaction_count now counts only transactions that are
-- settle-relevant for p_account_number:
--   * transactions whose cash account resolves to p_account_number, and
--   * transactions with no resolvable cash account (legacy rows, NULL
--     cash_account_id): they could belong to any account, so they keep
--     counting everywhere. This preserves today's behavior for
--     single-account companies where cash_account_id is often NULL.
-- The p_include_matched=false default filter uses the same account-scoped
-- check, so a transfer voucher's unsettled leg surfaces by default while a
-- voucher already settled on THIS account (genuine N:1, e.g. a salary run paid
-- in several transfers from one account) stays behind the opt-in toggle.
--
-- get_unlinked_gl_lines is deliberately untouched: it feeds auto-reconcile
-- flows, where surfacing the transfer's second leg could auto-link ambiguous
-- amounts. Manual matching keeps the human in the loop.
--
-- Signature, return shape, tenant guard (20260611140000) and grants
-- (20260611130000) are unchanged.

CREATE OR REPLACE FUNCTION public.get_account_gl_lines_for_matching(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL,
  p_include_matched BOOLEAN DEFAULT false
)
RETURNS TABLE (
  line_id                  UUID,
  journal_entry_id         UUID,
  debit_amount             NUMERIC,
  credit_amount            NUMERIC,
  line_description         TEXT,
  entry_date               DATE,
  voucher_number           INT,
  voucher_series           TEXT,
  entry_description        TEXT,
  source_type              TEXT,
  linked_transaction_count INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type,
    -- Account-scoped: a transaction provably on ANOTHER cash account (its
    -- cash_accounts row resolves to a different ledger_account) does not make
    -- this voucher "matched" for p_account_number. A NULL / unresolvable cash
    -- account keeps counting for every account (conservative legacy behavior).
    (
      SELECT count(*)
      FROM public.transactions t
      LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
        AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
    )::int AS linked_transaction_count
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND je.source_type IS DISTINCT FROM 'correction'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND (
      p_include_matched
      OR NOT EXISTS (
        SELECT 1
        FROM public.transactions t
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
          AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
      )
    )
    -- Tenant guard: anon/authenticated may only read their own companies;
    -- service_role and direct/superuser access (no JWT role) bypass.
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

-- CREATE OR REPLACE preserves the function's ACL, but re-assert least privilege
-- (20260611130000) so this migration stands alone if replayed on a fresh DB.
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

-- =============================================================================
-- 2. Guard mark_entry_as_opening_balance against entries with linked
--    transactions.
--
-- Before the account-scoped semantics above, a voucher with ANY linked bank
-- transaction never appeared in the reconciliation view's "Omatchade
-- verifikationer" table, so the "Märk som IB" button was unreachable for it.
-- A half-settled transfer voucher (manual/import source) now surfaces there,
-- making the button clickable on an entry whose other leg is already matched.
-- Re-tagging such an entry to 'opening_balance' would leave a live transaction
-- pointing at an IB entry and drop the voucher out of the period movement while
-- its transaction stays in the bank total: a permanent phantom difference.
-- An entry with a bank-feed counterpart is by definition not an ingående
-- balans, so refuse outright. Body otherwise verbatim from 20260619130100
-- (NOT 20260613120000: the 130100 revision added the claims-based 42501
-- tenant guard, which must survive this replace).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.mark_entry_as_opening_balance(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role     text;
  v_entry           record;
  v_is_closed       boolean;
  v_locked_at       timestamptz;
  v_has_bank_line   boolean;
  v_old_source_type text;
  v_jwt_role        text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  -- NULL-safe membership predicate (20260703180000): the raw
  -- NOT IN (SELECT user_company_ids()) pattern skips the deny branch on
  -- UNKNOWN and is ratchet-blocked by null-safe-tenant-guards.pg.test.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Owner/admin only (defense in depth alongside RLS; the function is SECURITY
  -- DEFINER so it must enforce tenancy + role itself).
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can re-tag opening balances';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted entries can be re-tagged as opening balance (current status: %)', v_entry.status;
  END IF;

  IF v_entry.source_type NOT IN ('manual', 'import') THEN
    RAISE EXCEPTION 'Only manual/import entries can be re-tagged as opening balance (current source_type: %)', v_entry.source_type;
  END IF;

  -- Must touch a bank/cash account. Re-tagging excludes the WHOLE entry from the
  -- reconciliation period movement, so it must genuinely be a bank-account IB.
  SELECT EXISTS (
    SELECT 1 FROM journal_entry_lines l
    WHERE l.journal_entry_id = p_entry_id
      AND l.account_number IN ('1910','1920','1930','1931','1932','1940','1941','1950')
  ) INTO v_has_bank_line;

  IF NOT v_has_bank_line THEN
    RAISE EXCEPTION 'Entry does not touch a bank/cash account (19xx); refusing to tag as opening balance';
  END IF;

  -- An entry with a linked bank transaction has a bank-feed counterpart and is
  -- therefore not an opening balance (a genuine IB predates the feed). It would
  -- also strand the linked transaction against an excluded entry, creating a
  -- permanent reconciliation difference. Unlink first if the tag is truly right.
  IF EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.journal_entry_id = p_entry_id
      AND t.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Entry has linked bank transactions; unlink them before re-tagging as opening balance';
  END IF;

  -- Respect period lock (mirror delete_last_voucher). enforce_period_lock would
  -- block the UPDATE anyway; we refuse first with a clearer message.
  SELECT is_closed, locked_at INTO v_is_closed, v_locked_at
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id;

  IF v_is_closed THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a closed fiscal period';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a locked fiscal period';
  END IF;

  v_old_source_type := v_entry.source_type;

  -- Transaction-local bypass consumed by the immutability carve-out
  -- (20260613120000).
  PERFORM set_config('gnubok.allow_source_type_retag', 'true', true);

  UPDATE journal_entries
  SET source_type = 'opening_balance'
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  -- Provenance row (write_audit_log also logs old/new state via the AFTER trigger;
  -- this adds the human-readable reason, matching the delete_last_voucher pattern).
  INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_entry.user_id,
    p_company_id,
    'UPDATE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    'Re-tagged source_type ' || v_old_source_type || ' -> opening_balance ' ||
    '(mark_entry_as_opening_balance RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'retagged', true,
    'entry_id', p_entry_id,
    'previous_source_type', v_old_source_type,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
