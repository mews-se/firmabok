-- Honest confidence for get_ledger_deep_context (data_quality_master.md Item C).
--
-- The raw dominant_account_share (cnt/total) reads "100% säkerhet" for an
-- entity with a single booking: fake certainty by construction (n=1 => 1.0).
-- This replace keeps the field name but makes it the Laplace-smoothed share
-- (cnt + 1) / (total + 2), the rule-of-succession estimate, so sample size
-- shrinks the displayed confidence: 1/1 -> 0.67, 3/3 -> 0.80, 12/13 -> 0.87.
-- The raw evidence is now exposed alongside it as dominant_account_count (cnt
-- on the dominant account) and dominant_account_total (all counted contra
-- lines), so the UI can say "bokförd hit i 12 av 13 fall".
--
-- Everything else is byte-identical to 20260708130000_ledger_deep_context.sql
-- (see that file's header for the full semantics: variant merging, cadence,
-- storno/19xx/26xx exclusions, SECURITY INVOKER + RLS scoping).
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
          -- SEK: amount_sek carries the converted value on foreign-currency
          -- rows and is null on SEK rows, so coalesce keeps everything in SEK
          -- (mirrors the supplier side's coalesce(total_sek, total)).
          abs(coalesce(t.amount_sek, t.amount)) AS amount
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
          sum(amount) AS total_amount,
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
               coalesce(si.total_sek, si.total, 0) AS amount
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
          sum(amount) AS total_amount,
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

REVOKE ALL ON FUNCTION public.get_ledger_deep_context(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_deep_context(uuid, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
