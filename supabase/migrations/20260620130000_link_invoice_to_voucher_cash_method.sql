-- Make link_invoice_to_voucher accounting-method aware (kontantmetoden support).
--
-- The customer-invoice voucher-link RPC (latest definition:
-- 20260615120000_link_voucher_rpcs_tenant_guard.sql) only ever matched
-- verifikat that CREDIT an AR account (151x). On kontantmetoden no 1510 is ever
-- booked — revenue is recognised at payment (debit 19xx / credit 30xx+26xx) —
-- so the candidate set was always empty and "Befintlig verifikation" was
-- unusable. (The previous out-of-scope note lived in lib/invoices/voucher-matching.ts.)
--
-- This version reads company_settings.accounting_method and branches step 3:
--   • cash    → sum the bank/cash DEBIT across the voucher's 19xx lines
--               (BAS class 19 — kassa/bank, covers 1910/1920/1930/1940…)
--   • accrual → sum the AR CREDIT across the voucher's 151x lines (unchanged)
-- Everything else (tenant guard, notes cap, attribution, locking, amount/
-- currency guards, the writes) is verbatim from 20260615120000. The internal
-- v_ar_credit_total name and the LINK_VOUCHER_NO_AR_CREDIT code are retained so
-- the TS/MCP callers map unchanged; the value simply carries the cash debit on
-- kontantmetoden. Mirrors the accounting-method branch in
-- lib/invoices/voucher-matching.ts so the staging preview and the commit agree.

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(
  p_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_ar_credit_total numeric := 0;
  v_line_currency text;
  v_remaining numeric;
  v_payment_amount numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_is_fully_paid boolean;
  v_now timestamptz := now();
  v_payment_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  v_accounting_method text;
BEGIN
  -- 0. Tenant guard (mirrors 20260611140000): anon/authenticated may only act
  --    on their own companies; service_role / direct access bypasses.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id NOT IN (SELECT public.user_company_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers —
    -- p_user_id cannot point the payment row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- 1. Lock the invoice for the duration of this transaction. FOR UPDATE so a
  --    concurrent linker has to wait until we commit (or roll back).
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount,
                          v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  -- 2. Resolve the voucher.
  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status)
    );
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NO_AR_CREDIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type)
    );
  END IF;

  -- 3. Sum the matched amount across the voucher's lines. Branch on the
  --    company's accounting method (defaults to accrual when no settings row).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  IF v_accounting_method = 'cash' THEN
    -- Kontantmetoden: the payment verifikat debits a liquid-funds account (19xx).
    SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
      INTO v_ar_credit_total, v_line_currency
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '19%'
      AND debit_amount > 0;
  ELSE
    -- Faktureringsmetoden: the payment verifikat credits the AR account (151x).
    SELECT COALESCE(SUM(credit_amount), 0), MAX(currency)
      INTO v_ar_credit_total, v_line_currency
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '151%'
      AND credit_amount > 0;
  END IF;

  v_ar_credit_total := ROUND(v_ar_credit_total * 100) / 100;

  IF v_ar_credit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_NO_AR_CREDIT');
  END IF;

  IF COALESCE(v_line_currency, v_invoice.currency) IS DISTINCT FROM v_invoice.currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  IF v_ar_credit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object(
        'ar_credit', v_ar_credit_total,
        'remaining', ROUND(v_remaining * 100) / 100
      )
    );
  END IF;

  -- 4. Reject re-link of the same voucher to the same invoice. Authoritative
  --    under the FOR UPDATE lock; the partial unique index
  --    idx_invoice_payments_je_inv_unique stays as the last line of defence
  --    for non-RPC writers.
  IF EXISTS (
    SELECT 1 FROM public.invoice_payments
    WHERE company_id = p_company_id
      AND invoice_id = p_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_ALREADY_LINKED');
  END IF;

  -- 5. Compute the advance.
  v_payment_amount := LEAST(v_ar_credit_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0,
    ROUND((v_remaining - v_payment_amount) * 100) / 100
  );
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  -- 6. Apply both writes. The RPC body is one transaction; a failure on the
  --    INSERT triggers PG's own rollback of the UPDATE — no manual rollback
  --    path needed.
  UPDATE public.invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN v_now ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_invoice_id;

  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, journal_entry_id, transaction_id, notes
  ) VALUES (
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice.currency, v_invoice.exchange_rate,
    p_journal_entry_id, NULL, p_notes
  )
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining,
    'payment_amount', v_payment_amount,
    'journal_entry_id', p_journal_entry_id,
    'currency', v_invoice.currency,
    'payment_date', v_voucher.entry_date
  );
END;
$$;

-- CREATE OR REPLACE preserves privileges, but re-apply the canonical write-RPC
-- grants explicitly (audit A5): never callable anonymously; authenticated covers
-- user sessions, service_role covers the MCP / API-key paths.
REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Atomically link an existing posted verifikat as payment for a customer invoice. Locks the invoice row, validates the voucher (faktureringsmetoden: credits 151x; kontantmetoden: debits 19xx), advances paid_amount/remaining_amount/status, and inserts an invoice_payments row in one PG transaction. Returns jsonb { ok, ..., payment_id } on success or { ok: false, code, details } on guard failure.';

NOTIFY pgrst, 'reload schema';
