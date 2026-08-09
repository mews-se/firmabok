-- Fix LPAD truncation in invoice number generation.
--
-- Postgres LPAD(string, length [, fill]) TRUNCATES on the right when string
-- is longer than length. So LPAD('10159', 3, '0') returns '101' — not the
-- '10159' the user expected. The previous migration (20260510120000)
-- preserved this LPAD pattern from the original 20260427150100 function
-- on the assumption that LPAD never truncates; that was wrong.
--
-- The customer-visible symptom: setting next_invoice_number = 10159 with
-- no prefix produces invoice number '101' instead of '10159', and the
-- preview surfaced the same '101'.
--
-- Fix: pad to at LEAST three digits, but never shorter than the actual
-- number. GREATEST(3, length(...)) is the simplest way to express that.

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
  SELECT invoice_number INTO v_existing
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  UPDATE public.company_settings
  SET next_invoice_number = next_invoice_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING invoice_prefix, next_invoice_number - 1
  INTO v_prefix, v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_final := CASE
    WHEN p_document_type = 'proforma' THEN 'PF-'
    ELSE COALESCE(v_prefix, '')
  END || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');

  UPDATE public.invoices
  SET invoice_number = v_final
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

CREATE OR REPLACE FUNCTION public.peek_next_invoice_number(
  p_company_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN p_document_type = 'proforma' THEN 'PF-'
           ELSE COALESCE(invoice_prefix, '')
         END || LPAD(next_invoice_number::text, GREATEST(3, length(next_invoice_number::text)), '0')
  FROM public.company_settings
  WHERE company_id = p_company_id
$function$;

NOTIFY pgrst, 'reload schema';
