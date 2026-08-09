-- Hide cancelled journal entries from the default /bookkeeping list view by
-- filtering them out inside list_fiscal_period_entries_with_related unless
-- the caller explicitly asks for status='cancelled'.
--
-- Why: prior data-cleanup operations (e.g. a one-off SIE re-import for a
-- specific tenant) left ~1,900 cancelled entries in journal_entries for
-- one company. The list view rendered them indistinguishably from posted
-- entries, so the user perceived them as duplicates of the new postings.
-- Hiding cancelled by default matches the convention already used by
-- trial-balance / balance-sheet / income-statement reads (which use
-- .in('status', ['posted', 'reversed'])).
--
-- Implementation: pure body change via CREATE OR REPLACE — no signature
-- change, so old API callers continue to work and immediately benefit from
-- the new behavior the moment this migration applies. No deploy-order risk.

CREATE OR REPLACE FUNCTION public.list_fiscal_period_entries_with_related(
  p_company_id uuid,
  p_period_id uuid,
  p_include_related boolean DEFAULT true,
  p_status text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sort_date text DEFAULT 'desc',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  entry jsonb,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH period AS (
    SELECT period_start, period_end
    FROM public.fiscal_periods
    WHERE id = p_period_id AND company_id = p_company_id
  ),
  matching AS (
    SELECT je.*
    FROM public.journal_entries je
    CROSS JOIN period p
    WHERE je.company_id = p_company_id
      AND (
        je.fiscal_period_id = p_period_id
        OR (
          p_include_related
          AND je.source_type IN ('invoice_paid','invoice_cash_payment','credit_note')
          AND EXISTS (
            SELECT 1 FROM public.invoices i
            WHERE i.id = je.source_id
              AND i.company_id = p_company_id
              AND i.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
        OR (
          p_include_related
          AND je.source_type IN ('supplier_invoice_paid','supplier_invoice_cash_payment','supplier_credit_note')
          AND EXISTS (
            SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = je.source_id
              AND si.company_id = p_company_id
              AND si.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
      )
      AND (p_status IS NULL OR je.status = p_status)
      -- Hide cancelled by default; show them only when caller asks explicitly.
      AND (je.status <> 'cancelled' OR p_status = 'cancelled')
      AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
      AND (p_date_to IS NULL OR je.entry_date <= p_date_to)
  ),
  matching_with_total AS (
    SELECT m.*, COUNT(*) OVER () AS total
    FROM matching m
  ),
  paged AS (
    SELECT *
    FROM matching_with_total
    ORDER BY
      CASE WHEN p_sort_date = 'asc'  THEN entry_date END ASC  NULLS LAST,
      CASE WHEN p_sort_date = 'desc' THEN entry_date END DESC NULLS LAST,
      voucher_series,
      voucher_number
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    (to_jsonb(p.*) - 'total')
      || jsonb_build_object(
        'lines', COALESCE(
          (SELECT jsonb_agg(to_jsonb(l.*) ORDER BY l.sort_order)
             FROM public.journal_entry_lines l
            WHERE l.journal_entry_id = p.id),
          '[]'::jsonb
        ),
        'out_of_period', (p.fiscal_period_id IS DISTINCT FROM p_period_id)
      ) AS entry,
    p.total AS total_count
  FROM paged p
  ORDER BY
    CASE WHEN p_sort_date = 'asc'  THEN p.entry_date END ASC  NULLS LAST,
    CASE WHEN p_sort_date = 'desc' THEN p.entry_date END DESC NULLS LAST,
    p.voucher_series,
    p.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
