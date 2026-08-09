-- Atomic, document_type-aware invoice number generation.
--
-- Replaces the single-arg signature with one that:
--   1. Locks the target invoice row (SELECT ... FOR UPDATE) so concurrent
--      callers serialize on the same draft.
--   2. Returns the existing number if the row already has one — idempotent;
--      the loser of a race never consumes a sequence number.
--   3. Allocates from company_settings.next_invoice_number only when needed.
--   4. Persists the assigned number on the invoice row in the same transaction.
--   5. Applies a 'PF-' prefix when document_type = 'proforma' so proformas
--      remain visually distinct from real invoices in the F-series.
--
-- Why this changes:
--   - The old single-arg version always advanced the per-company counter,
--     then a separate UPDATE in TS persisted it on the invoices row. Two
--     concurrent send calls on the same draft both incremented the counter,
--     and the loser's number was discarded — a permanent gap in the F-series.
--     Gaps are tolerated under Swedish practice but creating them through a
--     race is gratuitous and harms Skatteverket reconciliation traceability.
--   - The proforma 'PF-' prefix logic previously lived in the API route
--     (app/api/invoices/route.ts) and was lost when invoice_number became
--     nullable and assignment moved to ensureInvoiceNumber. Pushing the
--     prefix into the RPC keeps prefix logic next to the allocator.

DROP FUNCTION IF EXISTS public.generate_invoice_number(uuid);

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
  v_year text;
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

  -- 4. Compose: proforma -> 'PF-', otherwise use the company's invoice_prefix.
  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;
  v_final := CASE
    WHEN p_document_type = 'proforma' THEN 'PF-'
    ELSE COALESCE(v_prefix, '')
  END || v_year || LPAD(v_number::text, 3, '0');

  -- 5. Persist on the invoice row in the same transaction.
  UPDATE public.invoices
  SET invoice_number = v_final
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

NOTIFY pgrst, 'reload schema';
