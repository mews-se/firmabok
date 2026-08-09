-- Verifikationslista: optional draft exclusion + correction-group collapse.
--
-- Two new params on list_fiscal_period_entries_with_related:
--   p_exclude_draft        — when true, drafts are kept out of the committed
--                            list (they get their own "Utkast" surface).
--   p_collapse_corrections — when true, a correction group renders as ONE row:
--                            the live correction. The mechanical storno and the
--                            reversed original it replaced are hidden. Nothing
--                            is deleted — every voucher keeps its number and is
--                            reachable via the entry detail / chain view, and
--                            the UI exposes a "show all" toggle (param false).
--
-- Adding parameters changes the function identity, so we DROP the old 9-arg
-- signature first (CREATE OR REPLACE cannot add params) — otherwise PostgREST
-- sees two overloads and fails with "Could not choose the best candidate
-- function" when older callers pass only the original 9 named args. After the
-- drop+create there is a single 11-arg function; the two new params default to
-- false, so existing callers are unaffected.

DROP FUNCTION IF EXISTS public.list_fiscal_period_entries_with_related(
  uuid, uuid, boolean, text, date, date, text, int, int
);

CREATE FUNCTION public.list_fiscal_period_entries_with_related(
  p_company_id uuid,
  p_period_id uuid,
  p_include_related boolean DEFAULT true,
  p_status text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sort_date text DEFAULT 'desc',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_exclude_draft boolean DEFAULT false,
  p_collapse_corrections boolean DEFAULT false
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
      -- Drafts live on their own surface; exclude them only on the committed
      -- list. Ignored when the caller asked for an explicit status (so a
      -- status='draft' request is never self-cancelled) — mirrors the route's
      -- direct-query path.
      AND (NOT p_exclude_draft OR p_status IS NOT NULL OR je.status <> 'draft')
      -- Collapse correction groups to the live correction: drop the storno and
      -- the reversed original that a posted correction replaced.
      AND (
        NOT p_collapse_corrections
        OR (
          je.source_type <> 'storno'
          AND NOT EXISTS (
            SELECT 1 FROM public.journal_entries c
            WHERE c.company_id = p_company_id
              AND c.source_type = 'correction'
              AND c.status = 'posted'
              AND c.correction_of_id = je.id
          )
        )
      )
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
