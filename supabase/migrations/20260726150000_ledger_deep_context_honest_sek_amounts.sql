-- get_ledger_deep_context: stop counting a foreign amount as kronor.
--
-- Both amount expressions in 20260712130000_ledger_deep_context_laplace_share.sql
-- (itself a CREATE OR REPLACE of 20260708130000_ledger_deep_context.sql, so this
-- is the only live copy) fell back to the row's own currency amount whenever no
-- SEK value had been recorded:
--
--     abs(coalesce(t.amount_sek, t.amount))        -- counterparty / bank side
--     coalesce(si.total_sek, si.total, 0)          -- supplier / AP side
--
-- The coalesce is CORRECT for a SEK row: transactions.amount_sek and
-- supplier_invoices.total_sek are NULL by design on ordinary Swedish rows, where
-- the invoice-currency column already IS kronor. The failure case was never
-- considered: on a non-SEK row with no stored SEK value the same expression
-- yields the raw FOREIGN magnitude, and that number was then summed into
-- total_amount and used as a sort key. A 500 EUR supplier invoice entered the
-- ranking as 500 kr instead of roughly 5 750 kr, understating it by an order of
-- magnitude and pushing a genuinely smaller counterparty above it.
--
-- The AP side is the worse of the two: total_sek is NULL whenever the caller
-- merely omitted exchange_rate (that is exactly the cohort
-- 20260726120000_backfill_supplier_invoice_sek_amounts.sql deliberately left
-- NULL, because inventing a rate after the fact is not defensible), so the
-- fallback fires on live data rather than on a legacy edge case.
--
-- The rule applied here is the one the TypeScript layer already follows
-- (resolveSekAmountOrNull in lib/bookkeeping/mapping-engine.ts,
-- resolveTransactionAmountSek in lib/transactions/booking-duplicate-detection.ts,
-- and the unconverted_fx_count contract in lib/reports/ar-ledger.ts): if no SEK
-- value can be established, EXCLUDE the row from the money total and COUNT it.
-- Never guess the unit.
--
--   1. currency is SEK (NULL and '' read as SEK, matching `tx.currency || 'SEK'`
--      in TypeScript and the COALESCE in bulk_book_transactions)
--        -> the existing coalesce, unchanged, byte for byte. SEK rows produce
--           exactly the numbers they produced before this migration.
--   2. non-SEK with a stored SEK value    -> use it (also unchanged: the old
--                                            coalesce already picked it).
--   3. non-SEK, no stored SEK value, but an exchange_rate on the row
--                                         -> multiply. Deterministic arithmetic
--                                            on a rate the row already carries,
--                                            same statement 2 of the backfill.
--   4. non-SEK, no SEK value, no rate     -> NULL. sum() skips it, so it is out
--                                            of total_amount and out of the
--                                            total_amount sort key.
--
-- How the caller learns: each entity gains `unconverted_fx_count`, the number of
-- its rows that hit case 4. Additive, so no caller breaks: the return type stays
-- jsonb with the same two top-level keys, the signature is untouched, and
-- lib/agent-context/ledger-deep.ts maps entities through a spread. total_amount
-- is COALESCEd to 0 rather than left NULL so `DeepEntity.total_amount: number`
-- stays true; an entity whose whole history is unconvertible therefore reports
-- 0 kr WITH unconverted_fx_count > 0, which is the ar-ledger reading of a zero
-- total: "unknown", not "nothing". The entity is never dropped.
--
-- Deliberately NOT excluded: occurrences, cadence_days and the dominant-account
-- pick. Those are currency-free facts about a booking that really happened to a
-- real account, and they are the part of this payload the agent leans on hardest.
-- Only the money magnitude is withheld, because only the money magnitude is
-- unknown.
--
-- Everything else is byte-identical to 20260712130000 (variant merging, cadence,
-- Laplace-smoothed share, storno/19xx/26xx exclusions, LIMIT 40 / LIMIT 20,
-- SECURITY INVOKER + RLS scoping).
--
-- pg-test: tests/pg/ledger-deep-context-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_ledger_deep_context(
  p_company_id uuid,
  p_from_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'counterparty_entities',
    (
      WITH booked AS (
        SELECT
          public.normalize_counterparty_key(t.merchant_name) AS k,
          t.merchant_name,
          t.journal_entry_id,
          t.date,
          -- SEK, or NULL when no SEK value can be established. NULL is the whole
          -- point: it drops out of sum() below instead of entering the total at
          -- its foreign face value.
          CASE
            -- SEK row: amount_sek is NULL here by design and `amount` already IS
            -- kronor, so this is the pre-existing coalesce untouched.
            WHEN upper(coalesce(nullif(btrim(t.currency), ''), 'SEK')) = 'SEK'
              THEN abs(coalesce(t.amount_sek, t.amount))
            -- Foreign row converted at ingest.
            WHEN t.amount_sek IS NOT NULL
              THEN abs(t.amount_sek)
            -- Foreign row carrying the rate it was recorded at.
            WHEN t.exchange_rate IS NOT NULL AND t.exchange_rate > 0
              THEN round(abs(t.amount) * t.exchange_rate, 2)
            -- Foreign row with neither: unknown in SEK, never assumed.
            ELSE NULL
          END AS amount
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          AND je.source_type <> 'storno'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND (p_from_date IS NULL OR t.date >= p_from_date)
      ),
      keyed AS (SELECT * FROM booked WHERE k <> ''),
      -- Median gap between distinct booking dates -> recurrence cadence.
      distinct_dates AS (SELECT DISTINCT k, date FROM keyed),
      gaps AS (
        SELECT k, (date - lag(date) OVER (PARTITION BY k ORDER BY date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT k, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY k
      ),
      -- Dominant contra account + its share, over the entity's verifikat lines.
      -- Rows with no SEK value stay in here on purpose: which account a booking
      -- went to is a fact that does not depend on the currency.
      acct_counts AS (
        SELECT b.k, l.account_number, count(*)::bigint AS cnt
        FROM keyed b
        JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
        WHERE l.account_number NOT LIKE '19%'
          AND l.account_number NOT LIKE '26%'
        GROUP BY b.k, l.account_number
      ),
      acct_totals AS (SELECT k, sum(cnt) AS total FROM acct_counts GROUP BY k),
      dominant_account AS (
        SELECT DISTINCT ON (ac.k) ac.k, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.k = ac.k
        ORDER BY ac.k, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          k,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          count(DISTINCT merchant_name)::int AS variant_count,
          (array_agg(DISTINCT merchant_name))[1:8] AS variants,
          -- sum() skips the NULLs from case 4. COALESCE keeps the field a number
          -- when every row was unconvertible.
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(date) AS first_seen,
          max(date) AS last_seen
        FROM keyed GROUP BY k
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.display_name,
            'key', a.k,
            'variants', to_jsonb(a.variants),
            'variant_count', a.variant_count,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Bookings whose SEK value could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.display_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, display_name LIMIT 40) a
      LEFT JOIN recur r ON r.k = a.k
      LEFT JOIN dominant_account da ON da.k = a.k
    ),
    'supplier_entities',
    (
      WITH sinv AS (
        SELECT si.id, si.supplier_id, s.name AS supplier_name,
               si.invoice_date, si.vat_treatment,
               -- Same four cases as the counterparty side. total_sek is NULL on
               -- every foreign invoice registered without an exchange_rate, so
               -- case 4 is the live cohort here, not an edge case.
               CASE
                 WHEN upper(coalesce(nullif(btrim(si.currency), ''), 'SEK')) = 'SEK'
                   THEN coalesce(si.total_sek, si.total, 0)
                 WHEN si.total_sek IS NOT NULL
                   THEN si.total_sek
                 WHEN si.exchange_rate IS NOT NULL AND si.exchange_rate > 0
                   THEN round(coalesce(si.total, 0) * si.exchange_rate, 2)
                 ELSE NULL
               END AS amount
        FROM public.supplier_invoices si
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = p_company_id
          AND si.status NOT IN ('reversed', 'credited')
          AND si.is_credit_note = false
          AND (p_from_date IS NULL OR si.invoice_date >= p_from_date)
      ),
      distinct_dates AS (SELECT DISTINCT supplier_id, invoice_date FROM sinv),
      gaps AS (
        SELECT supplier_id,
               (invoice_date - lag(invoice_date) OVER (PARTITION BY supplier_id ORDER BY invoice_date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT supplier_id, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY supplier_id
      ),
      acct_counts AS (
        SELECT v.supplier_id, i.account_number, count(DISTINCT v.id)::bigint AS cnt
        FROM sinv v JOIN public.supplier_invoice_items i ON i.supplier_invoice_id = v.id
        GROUP BY v.supplier_id, i.account_number
      ),
      acct_totals AS (SELECT supplier_id, sum(cnt) AS total FROM acct_counts GROUP BY supplier_id),
      dominant_account AS (
        SELECT DISTINCT ON (ac.supplier_id) ac.supplier_id, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.supplier_id = ac.supplier_id
        ORDER BY ac.supplier_id, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          supplier_id,
          max(supplier_name) AS supplier_name,
          count(*)::bigint AS occurrences,
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(invoice_date) AS first_seen,
          max(invoice_date) AS last_seen,
          mode() WITHIN GROUP (ORDER BY vat_treatment) AS dominant_vat
        FROM sinv GROUP BY supplier_id
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.supplier_name,
            'key', a.supplier_id::text,
            'variants', to_jsonb(ARRAY[a.supplier_name]),
            'variant_count', 1,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Invoices whose SEK total could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total,
            'dominant_vat', a.dominant_vat
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.supplier_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, supplier_name LIMIT 20) a
      LEFT JOIN recur r ON r.supplier_id = a.supplier_id
      LEFT JOIN dominant_account da ON da.supplier_id = a.supplier_id
    )
  );
$$;

COMMENT ON FUNCTION public.get_ledger_deep_context(uuid, date) IS
  'Deep entity-resolved ledger analysis behind "Vad din agent vet". total_amount is SEK only: a non-SEK row with neither a stored SEK value nor an exchange_rate is excluded from the sum and from the total_amount sort key, and counted in unconverted_fx_count instead of being added at its foreign face value. occurrences, cadence_days and the dominant-account pick are currency-free and still include those rows.';

REVOKE ALL ON FUNCTION public.get_ledger_deep_context(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_deep_context(uuid, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
