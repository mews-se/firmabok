-- Peek the next invoice number without consuming the sequence.
--
-- generate_invoice_number() atomically increments and persists, which is
-- the right behavior at send/save time but unsuitable for previewing in
-- the UI. peek_next_invoice_number() reads the same fields and applies the
-- same composition rules (matching the no-year-prefix format from
-- 20260510120000) without modifying state.
--
-- Important: this is a preview only. Two callers reading concurrently
-- might both see the same number; the actual allocator (generate_…) is
-- the source of truth and assigns atomically. The UI re-fetches before
-- submit so the preview reflects fresh state.

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
         END || LPAD(next_invoice_number::text, 3, '0')
  FROM public.company_settings
  WHERE company_id = p_company_id
$function$;

NOTIFY pgrst, 'reload schema';
