-- RPC: get_kpi_report_aggregates: one-round-trip aggregation for the KPI
-- report (app/api/reports/kpi).
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The report.kpi handler used to scan every journal line of the fiscal
-- period THREE times through PostgREST and aggregate in JS:
--   1. generateTrialBalance (unfiltered) for balance-side KPIs,
--   2. generateIncomeStatement, which re-runs generateTrialBalance with
--      excludeYearEndClosing,
--   3. generateMonthlyBreakdown with its own paginated line fetch.
-- Each scan pays sequential cross-region round trips (Vercel iad1 to
-- Supabase eu-north-1) per 1000-row page. One SQL pass now returns all
-- three aggregate shapes; the JS side only merges opening balances and
-- formats rows, so the payload is O(accounts + months), not O(lines).
--
-- SECTION SEMANTICS (each mirrors an existing TypeScript fetch; the
-- pg-real test pins them):
--   tb             per-account debit/credit sums over the period's posted
--                  and reversed entries, excluding the opening-balance
--                  entry (p_ob_entry_id) so its values are not double
--                  counted against the IB. Mirrors the period-lines fetch
--                  in lib/reports/trial-balance.ts (no entry_date filter:
--                  fiscal_period_id already bounds activity).
--   tb_ex_year_end same, additionally excluding every source_type
--                  'year_end' entry plus stornos/corrections of REVERSED
--                  year-end entries. ye_reversed is COMPANY-WIDE (no
--                  period filter), mirroring trial-balance.ts wave-1.
--                  source_type is NOT NULL, so IS DISTINCT FROM matches
--                  the PostgREST .neq() exactly.
--   ob             per-account sums of the opening-balance entry's lines.
--                  NO status filter, mirroring getOpeningBalances
--                  (lib/reports/opening-balances.ts) which only checks
--                  id + company_id. Empty when p_ob_entry_id IS NULL.
--   monthly        income/expenses per calendar month over POSTED entries
--                  only (lib/reports/monthly-breakdown.ts): class 3 =
--                  income (credit-debit), classes 4-7 = expenses
--                  (debit-credit), class 8 split PER LINE by sign of
--                  credit-debit, and 8999 excluded entirely (the closing
--                  account would cancel the income-vs-expense signal).
--                  The OB entry and year_end entries are NOT excluded
--                  here: the JS scan never excluded them either.
--
-- SECURITY INVOKER: journal_entries/journal_entry_lines RLS is
-- company-scoped via user_company_ids(), so the caller's own membership
-- bounds what is aggregated; a non-member calling with a foreign company
-- id gets empty sections, not an error. Service-role callers rely on the
-- explicit p_company_id filter.
--
-- pg-test: tests/pg/kpi-report-aggregates-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_kpi_report_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_ob_entry_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
WITH period_entries AS (
  SELECT id, entry_date, status, source_type, reverses_id, correction_of_id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status IN ('posted', 'reversed')
),
tb_entries AS (
  SELECT * FROM period_entries
  WHERE p_ob_entry_id IS NULL OR id <> p_ob_entry_id
),
ye_reversed AS (
  -- Company-wide (no period filter), mirroring the wave-1 fetch in
  -- lib/reports/trial-balance.ts: a storno in this period can reverse a
  -- year-end entry from another period.
  SELECT id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND source_type = 'year_end'
    AND status = 'reversed'
),
tb_ex_ye_entries AS (
  SELECT * FROM tb_entries
  WHERE source_type IS DISTINCT FROM 'year_end'
    AND (reverses_id IS NULL
         OR reverses_id NOT IN (SELECT id FROM ye_reversed))
    AND (correction_of_id IS NULL
         OR correction_of_id NOT IN (SELECT id FROM ye_reversed))
)
SELECT jsonb_build_object(
  'tb', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'tb_ex_year_end', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_ex_ye_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'ob', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      -- No status filter: getOpeningBalances only checks id + company_id.
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e
        ON e.id = l.journal_entry_id
       AND e.id = p_ob_entry_id
       AND e.company_id = p_company_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'monthly', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'year', m.year,
      'month', m.month,
      'income', m.income,
      'expenses', m.expenses
    ) ORDER BY m.year, m.month)
    FROM (
      SELECT EXTRACT(YEAR FROM e.entry_date)::int AS year,
             EXTRACT(MONTH FROM e.entry_date)::int AS month,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^3'
                 THEN l.credit_amount - l.debit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number <> '8999'
                  AND (l.credit_amount - l.debit_amount) >= 0
                 THEN l.credit_amount - l.debit_amount
               END), 0)
             )::float8 AS income,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^[4-7]'
                 THEN l.debit_amount - l.credit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number <> '8999'
                  AND (l.credit_amount - l.debit_amount) < 0
                 THEN l.debit_amount - l.credit_amount
               END), 0)
             )::float8 AS expenses
      FROM public.journal_entry_lines l
      JOIN period_entries e
        ON e.id = l.journal_entry_id
       AND e.status = 'posted'
      WHERE l.account_number ~ '^[3-8]'
      GROUP BY 1, 2
    ) m
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
