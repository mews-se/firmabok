-- Harden invoice-number RPCs with inline membership check + empty search_path.
--
-- Compliance hardening triggered by external audit (OWASP V8.2.1, SOC 2 CC6.1,
-- ISO 27001 A.8.28).
--
-- generate_invoice_number and peek_next_invoice_number are SECURITY DEFINER,
-- which means they execute with elevated privileges and bypass the caller's
-- RLS. They are reached from the /api/invoices/next-number route, which
-- already validates company membership at the application layer
-- (lib/company/context.ts → withRouteContext). This migration adds two layers
-- of defense-in-depth at the DB layer:
--
--   1. Inline membership check using auth.uid() against public.company_members.
--      Skipped when auth.uid() is NULL (service role / cron / pg-real
--      superuser tests that bypass JWT context). This mirrors how Supabase's
--      service role bypasses RLS by design.
--
--   2. SET search_path = '' (was 'public'). All table/function references
--      below are now schema-qualified so they cannot be hijacked by an
--      object created in another schema later on the search path.
--      pg_catalog is searched implicitly so built-in functions (LPAD,
--      GREATEST, COALESCE, length, now) still resolve without qualification.
--
-- Behaviour for the LPAD / proforma / GREATEST(3, length) logic is preserved
-- verbatim from 20260510130000_invoice_number_no_truncate.sql.

CREATE OR REPLACE FUNCTION public.generate_invoice_number(
  p_company_id uuid,
  p_invoice_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing text;
  v_prefix text;
  v_number integer;
  v_final text;
BEGIN
  -- Defense-in-depth: refuse to operate on companies the caller is not a
  -- member of. NULL auth.uid() (service role / cron / superuser) is allowed
  -- through; those code paths are trusted and need to operate across tenants.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_prefix text;
  v_number integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice_prefix, next_invoice_number INTO v_prefix, v_number
  FROM public.company_settings
  WHERE company_id = p_company_id;

  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN CASE
           WHEN p_document_type = 'proforma' THEN 'PF-'
           ELSE COALESCE(v_prefix, '')
         END || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');
END;
$function$;

NOTIFY pgrst, 'reload schema';
