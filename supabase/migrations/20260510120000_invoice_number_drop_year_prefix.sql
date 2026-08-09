-- Drop the unconditional year prefix from generate_invoice_number().
--
-- The previous version (20260427150100) always inserted EXTRACT(YEAR FROM
-- CURRENT_DATE) between the company prefix and the sequence number. That
-- silently overrode the user's "Nästa fakturanummer" setting: a customer
-- migrating from another system who set next_invoice_number = 10159 would
-- get '2026<n>' instead of '10159'. There was no way to opt out of the
-- year injection short of leaving prefix=NULL and accepting the surprise.
--
-- New format:
--   proforma  -> 'PF-' || LPAD(number::text, 3, '0')
--   otherwise -> COALESCE(invoice_prefix, '') || LPAD(number::text, 3, '0')
--
-- Customers who *want* a year prefix put it in invoice_prefix explicitly
-- (e.g. 'F-2026-' or '2026'). LPAD pads small numbers but never truncates,
-- so bumping next_invoice_number to a high value continues to render the
-- full number.
--
-- Backfill: if a company has 2+ existing invoices whose numbers match the
-- old year-prefixed format (^\d{4}\d+$) and shares a single year, backfill
-- invoice_prefix to that year so their next invoice keeps visual
-- continuity. Single-invoice companies are skipped — they're likely fresh
-- migrators (like C by Sea) whose first invoice was the buggy year-prefix
-- output, and forcing the prefix on them would defeat the fix.

DROP FUNCTION IF EXISTS public.generate_invoice_number(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.generate_invoice_number(
  p_company_id uuid,
  p_invoice_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing text;
  v_prefix text;
  v_number integer;
  v_final text;
BEGIN
  -- 1. Lock the invoice row. Concurrent callers block here until the first
  --    transaction commits, then see the persisted number on retry.
  SELECT invoice_number INTO v_existing
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  -- 2. Idempotent: if the number is already set, return it without consuming
  --    the sequence. This is also the path concurrent callers take after
  --    unblocking from the row lock.
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 3. Allocate from per-company counter atomically. UPDATE ... RETURNING is
  --    serialized by Postgres on the company_settings row.
  UPDATE public.company_settings
  SET next_invoice_number = next_invoice_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING invoice_prefix, next_invoice_number - 1
  INTO v_prefix, v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  -- 4. Compose: proforma -> 'PF-', otherwise the company's invoice_prefix.
  --    No year injection — the prefix is the only place it can live.
  v_final := CASE
    WHEN p_document_type = 'proforma' THEN 'PF-'
    ELSE COALESCE(v_prefix, '')
  END || LPAD(v_number::text, 3, '0');

  -- 5. Persist on the invoice row in the same transaction.
  UPDATE public.invoices
  SET invoice_number = v_final
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

-- Backfill: preserve visual continuity for established companies that
-- relied on the implicit year prefix. Only touch companies with 2+ existing
-- invoices that all share a single 4-digit year prefix and currently have
-- invoice_prefix=NULL.
UPDATE public.company_settings cs
SET invoice_prefix = sub.year_str,
    updated_at = now()
FROM (
  SELECT i.company_id,
         (regexp_match(i.invoice_number, '^(\d{4})\d+$'))[1] AS year_str,
         COUNT(*) AS hits
  FROM public.invoices i
  WHERE i.invoice_number ~ '^\d{4}\d+$'
  GROUP BY i.company_id, (regexp_match(i.invoice_number, '^(\d{4})\d+$'))[1]
  HAVING COUNT(*) >= 2
) sub
WHERE cs.company_id = sub.company_id
  AND cs.invoice_prefix IS NULL
  -- If a company has invoices spanning multiple years (e.g. 2025001 and
  -- 2026001), the subquery returns a row per year; pick the most recent.
  AND sub.year_str = (
    SELECT (regexp_match(i2.invoice_number, '^(\d{4})\d+$'))[1]
    FROM public.invoices i2
    WHERE i2.company_id = cs.company_id
      AND i2.invoice_number ~ '^\d{4}\d+$'
    ORDER BY i2.invoice_date DESC NULLS LAST, i2.created_at DESC
    LIMIT 1
  );

NOTIFY pgrst, 'reload schema';
