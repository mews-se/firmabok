-- Restate both voucher-link RPCs with the NULL-safe tenant guard.
--
-- 20260726140000 (the invoice-currency rewrite of these two RPCs) was already
-- recorded on the PR #1215 Supabase preview branch when review hardening
-- swapped its membership guard from the raw NOT-IN-over-user_company_ids()
-- shape to caller_is_company_member() (20260703180000). A recorded migration
-- version never re-runs, so editing that file in place could not reach any
-- database that had already applied it, and it broke the byte-identical rule
-- for applied migrations. That file is restored to the exact content the
-- preview recorded; the corrected definitions land here under a fresh version.
--
-- CREATE OR REPLACE makes the sequence converge everywhere: a database that
-- applied the weaker guard (the preview) replays these bodies on top, and a
-- fresh replay (prod at merge, pg-real CI) ends up byte-identical in prosrc.
-- The pg-real ratchet (tests/pg/null-safe-tenant-guards.pg.test.ts) pins the
-- final state.
--
-- The full rationale for the RPC bodies themselves (resolving the matched
-- voucher amount in the invoice's currency) lives in 20260726140000; nothing
-- below differs from it except the two tenant-guard sites and their comments.

-- Resolve the matched voucher amount in the INVOICE'S currency in both
-- voucher-link commit RPCs.
--
-- THE BUG: `journal_entry_lines.debit_amount` / `credit_amount` are ALWAYS SEK.
-- `lib/bookkeeping/currency-utils.ts` (resolveSekAmount + buildCurrencyMetadata)
-- converts a foreign amount to kronor for those columns and then stamps
-- `currency` + `amount_in_currency` onto the SAME line as metadata about the
-- underlying DOCUMENT. `currency` is therefore a LABEL, never evidence that the
-- debit/credit figure is quoted in it.
--
-- Both RPCs summed the always-SEK column into v_ar_credit_total /
-- v_ap_debit_total and then compared it against v_remaining, which comes from
-- invoices.remaining_amount / supplier_invoices.remaining_amount and is quoted
-- in the invoice's OWN currency (`*_sek` carries the SEK equivalent). The
-- currency guard that was supposed to make that safe,
--
--   COALESCE(v_line_currency, v_invoice.currency) IS DISTINCT FROM v_invoice.currency
--
-- passes on exactly the FX rows it exists to catch: a EUR invoice's payment line
-- is labelled 'EUR', so the labels match and the guard waves through a
-- comparison between 11 500 (kronor) and 1 000 (euro).
--
-- Consequences on a foreign invoice, all reachable today:
--   • LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING on the one voucher that is correct
--     (11 500 > 1 000), so the invoice cannot be linked at all;
--   • where it did not trip that guard, LEAST(v_..._total, v_remaining) wrote a
--     payment_amount in the wrong unit into invoice_payments /
--     supplier_invoice_payments and advanced paid_amount by it.
--
-- The RPCs are the authoritative commit path, not a second opinion:
-- `linkInvoiceToVoucher()` / `linkSupplierInvoiceToVoucher()` call them
-- directly, and the web routes (app/api/{invoices,supplier-invoices}/[id]/
-- link-to-voucher) plus lib/invoices/bulk-reconcile-supplier-vouchers.ts reach
-- them without any TypeScript pre-validation. Fixing the TS matchers alone
-- therefore only surfaces the correct candidate and then fails to commit it.
--
-- THE FIX mirrors `ledgerLineSideAmountIn()`
-- (lib/bookkeeping/ledger-line-amount.ts) exactly:
--   • invoice currency SEK  → sum the raw side column, VERBATIM as before. The
--     ledger columns already hold kronor, so the label is irrelevant. This is
--     the 95% path and it is byte-identical: SEK-only companies see no change
--     whatsoever, including the existing label guard below.
--   • invoice currency anything else → the magnitude comes from
--     ABS(amount_in_currency) on lines actually labelled with that currency;
--     direction is already established by the `side > 0` predicate. A
--     matched-side line that carries no figure in that currency (different
--     label, or no rate at all) makes the voucher UNREADABLE, and we fail closed
--     with a CURRENCY_MISMATCH rather than summing only the readable lines and
--     silently understating a voucher that settles more than we can see.
--
-- The RESOLVED currency (v_invoice_currency, NULL normalized to 'SEK') is
-- used consistently: in the label guard, in the persisted payment row and in
-- the returned jsonb. Comparing the guard against the RAW nullable column
-- made a legacy NULL-currency invoice unlinkable ('SEK' IS DISTINCT FROM NULL
-- is true, so every ordinary domestic payment raised CURRENCY_MISMATCH), and
-- the insert persisted that NULL into invoice_payments.currency.
--
-- Everything else in both functions (tenant guard, notes cap, attribution,
-- FOR UPDATE locking, the already-linked check, the amount guard, the writes,
-- the returned jsonb) matches the LIVE definitions: the bodies from
-- 20260620130000_link_invoice_to_voucher_cash_method.sql and
-- 20260615120000_link_voucher_rpcs_tenant_guard.sql respectively, as
-- mechanically rewritten by 20260703180000_null_safe_tenant_guards.sql
-- (the membership guard is caller_is_company_member(), not the raw
-- NOT IN pattern those older files carry).
--
-- No schema change, no trigger touched: two CREATE OR REPLACE FUNCTION bodies.

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
  -- Unit resolution (new): the currency the invoice's amounts are quoted in,
  -- plus the matched-side lines that cannot be expressed in it.
  v_invoice_currency text;
  v_account_prefix text;
  v_unreadable_count integer := 0;
  v_unreadable_currency text;
BEGIN
  -- 0. Tenant guard (mirrors 20260611140000): anon/authenticated may only act
  --    on their own companies; service_role / direct access bypasses. The
  --    NULL-safe caller_is_company_member() form (20260703180000), not the
  --    raw NOT-IN-over-user_company_ids() shape: that one skips the deny
  --    branch on UNKNOWN and is banned by the pg-real ratchet
  --    (tests/pg/null-safe-tenant-guards.pg.test.ts, which scans prosrc:
  --    comments included, so the banned shape must not even be spelled out
  --    here).
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers:
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

  -- 3. Sum the matched amount across the voucher's lines, EXPRESSED IN THE
  --    INVOICE'S CURRENCY. Branch on the company's accounting method (defaults
  --    to accrual when no settings row).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  -- `invoices.currency` is `text default 'SEK'` and therefore NULLABLE; a
  -- missing code has always meant kronor, and must not be read as "not SEK".
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');
  v_account_prefix := CASE WHEN v_accounting_method = 'cash' THEN '19' ELSE '151' END;

  IF v_invoice_currency = 'SEK' THEN
    -- VERBATIM from 20260620130000. The ledger columns are kronor already, so
    -- the document label on the line is irrelevant here.
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
  ELSE
    -- Foreign invoice: `amount_in_currency` is the only column quoted in the
    -- invoice's currency. Magnitude from ABS() because a handful of production
    -- rows store the foreign figure negatively while the debit/credit side is
    -- authoritative, and that side is already pinned by the `> 0` predicate.
    SELECT
      COALESCE(SUM(ABS(l.amount_in_currency)) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ), 0),
      MAX(l.currency) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ),
      COUNT(*) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      ),
      MIN(l.currency) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      )
      INTO v_ar_credit_total, v_line_currency, v_unreadable_count, v_unreadable_currency
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND l.account_number LIKE v_account_prefix || '%'
      AND (CASE WHEN v_accounting_method = 'cash' THEN l.debit_amount ELSE l.credit_amount END) > 0;

    -- Fail CLOSED on a matched-side line we cannot read in the invoice's
    -- currency: summing only the readable ones would understate the voucher.
    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'line_currency', v_unreadable_currency
        )
      );
    END IF;
  END IF;

  v_ar_credit_total := ROUND(v_ar_credit_total * 100) / 100;

  IF v_ar_credit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_NO_AR_CREDIT');
  END IF;

  -- Label guard, still load-bearing, but no longer as a unit check:
  -- v_ar_credit_total is already in the invoice's currency. What it catches
  -- now is a counterparty discriminator, a matched line stamped with some
  -- other document's currency. Always passes on a foreign invoice, because
  -- only same-labelled lines could be read at all. Both sides compare the
  -- RESOLVED v_invoice_currency, never the raw nullable column: with the raw
  -- column, a legacy NULL-currency invoice (which has always meant SEK) hit
  -- 'SEK' IS DISTINCT FROM NULL = true and an ordinary domestic payment
  -- raised LINK_VOUCHER_CURRENCY_MISMATCH forever.
  IF COALESCE(v_line_currency, v_invoice_currency) IS DISTINCT FROM v_invoice_currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  -- Both sides are now in the invoice's currency.
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
  --    INSERT triggers PG's own rollback of the UPDATE: no manual rollback
  --    path needed.
  UPDATE public.invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN v_now ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_invoice_id;

  -- The payment row persists the RESOLVED currency: writing the raw column
  -- would store NULL for a legacy NULL-currency invoice, and the payment's
  -- unit is a fact this row must state, not inherit as "unknown".
  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, journal_entry_id, transaction_id, notes
  ) VALUES (
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_invoice.exchange_rate,
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
    'currency', v_invoice_currency,
    'payment_date', v_voucher.entry_date
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
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
  v_ap_debit_total numeric := 0;
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
  -- Unit resolution (new), as in link_invoice_to_voucher above.
  v_invoice_currency text;
  v_unreadable_count integer := 0;
  v_unreadable_currency text;
BEGIN
  -- Tenant guard (mirrors 20260611140000): anon/authenticated may only act on
  -- their own companies; service_role / direct access bypasses. NULL-safe
  -- caller_is_company_member() form, as in link_invoice_to_voucher above.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers:
    -- p_user_id cannot point the payment row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type));
  END IF;

  -- Sum the AP debit across the full 244x range, EXPRESSED IN THE INVOICE'S
  -- CURRENCY. `supplier_invoices.currency` is NOT NULL DEFAULT 'SEK', but the
  -- COALESCE keeps this symmetric with the customer side.
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');

  IF v_invoice_currency = 'SEK' THEN
    -- VERBATIM from 20260615120000: the ledger column is kronor already.
    SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
      INTO v_ap_debit_total, v_line_currency
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '244%'
      AND debit_amount > 0;
  ELSE
    SELECT
      COALESCE(SUM(ABS(l.amount_in_currency)) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ), 0),
      MAX(l.currency) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ),
      COUNT(*) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      ),
      MIN(l.currency) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      )
      INTO v_ap_debit_total, v_line_currency, v_unreadable_count, v_unreadable_currency
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND l.account_number LIKE '244%'
      AND l.debit_amount > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'line_currency', v_unreadable_currency
        ));
    END IF;
  END IF;

  v_ap_debit_total := ROUND(v_ap_debit_total * 100) / 100;

  IF v_ap_debit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT');
  END IF;

  -- Label guard: a counterparty discriminator, not a unit check. Compares the
  -- RESOLVED currency on both sides, as in link_invoice_to_voucher above.
  IF COALESCE(v_line_currency, v_invoice_currency) IS DISTINCT FROM v_invoice_currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency, 'line_currency', v_line_currency));
  END IF;

  -- Both sides are now in the invoice's currency.
  IF v_ap_debit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object('ap_debit', v_ap_debit_total, 'remaining', ROUND(v_remaining * 100) / 100));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_ALREADY_LINKED');
  END IF;

  v_payment_amount := LEAST(v_ap_debit_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0, ROUND((v_remaining - v_payment_amount) * 100) / 100);
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN v_now ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_supplier_invoice_id;

  INSERT INTO public.supplier_invoice_payments (
    user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
    journal_entry_id, transaction_id, notes
  ) VALUES (
    v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, p_journal_entry_id, NULL, p_notes
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
    'currency', v_invoice_currency
  );
END;
$$;

-- Grants are unchanged from 20260615120000 / 20260620130000 and restated here
-- because CREATE OR REPLACE does not alter them: `authenticated` covers
-- user-session clients, `service_role` the MCP / API-key paths.
REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Link a posted verifikat to a customer invoice as its payment. Accounting-method aware (151x credit on faktureringsmetoden, 19xx debit on kontantmetoden). The matched amount is resolved in the INVOICE''S currency: the raw ledger column on a SEK invoice, ABS(amount_in_currency) on a foreign one, refusing when a matched-side line carries no figure in that currency. journal_entry_lines.currency labels the document, not the debit/credit unit.';

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Link a posted verifikat to a supplier invoice as its payment, summing the 244x debit in the INVOICE''S currency: the raw ledger column on a SEK invoice, ABS(amount_in_currency) on a foreign one, refusing when a 244x debit carries no figure in that currency.';

NOTIFY pgrst, 'reload schema';
