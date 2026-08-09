-- RPC: list journal entries for a fiscal period, optionally including
-- follow-up entries booked in a later period that relate to aggregates
-- that originated in the selected period.
--
-- Why this exists: journal_entries.fiscal_period_id is strictly bound to
-- entry_date (validated in lib/bookkeeping/engine.ts). So a customer
-- invoice created in FY2025 and paid in FY2026 produces two entries in
-- two different periods, and filtering the /bookkeeping view by
-- fiscal_period_id hides the tail of the story. Users reviewing a past
-- fiscal year expect to see the full processing history for that year's
-- aggregates (behandlingshistorik per BFL/BFNAR).
--
-- Expansion rules (when p_include_related = true):
--   - Entries with source_type in invoice follow-ups whose invoice was
--     dated inside the selected period.
--   - Same for supplier invoice follow-ups.
--
-- Storno and correction entries inherit fiscal_period_id from their
-- original (see lib/bookkeeping/engine.ts reverseEntry and
-- lib/core/bookkeeping/storno-service.ts), so they are already captured
-- by the primary fiscal_period_id filter — no extra rule needed.
--
-- Currency revaluation is booked within the period it revalues, also
-- captured by the primary filter.
--
-- Returns jsonb rows shaped like the PostgREST response used by
-- GET /api/bookkeeping/journal-entries (entry + nested lines), plus an
-- out_of_period boolean the UI uses to badge tail entries.

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

GRANT EXECUTE ON FUNCTION public.list_fiscal_period_entries_with_related(
  uuid, uuid, boolean, text, date, date, text, int, int
) TO authenticated;

NOTIFY pgrst, 'reload schema';
