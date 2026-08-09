-- The delivery summary hid attachment_filename, so the UI could only show a
-- generic "faktura.pdf" label for the archived send snapshot. The filename is
-- derived from company name, customer name, invoice number, and date: the same
-- information the invoice itself already exposes to every company member, so
-- returning it does not widen the minimization boundary set in 20260723003000.
-- Addresses stay masked; message content, BCC, and checksums stay server-side.

DROP FUNCTION IF EXISTS public.list_invoice_delivery_summaries(uuid, uuid);

CREATE FUNCTION public.list_invoice_delivery_summaries(
  p_company_id uuid,
  p_invoice_id uuid
)
RETURNS TABLE (
  id uuid,
  channel text,
  status text,
  to_addresses text[],
  cc_addresses text[],
  provider text,
  error_code text,
  document_attachment_id uuid,
  attachment_filename text,
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL
    OR p_company_id IS DISTINCT FROM public.current_active_company_id()
    OR NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      WHERE cm.company_id = p_company_id
        AND cm.user_id = auth.uid()
    )
  THEN
    RAISE EXCEPTION 'not authorized to list invoice delivery summaries'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.channel,
    d.status,
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(d.to_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(d.cc_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    d.provider,
    d.error_code,
    d.document_attachment_id,
    d.attachment_filename,
    d.sent_at,
    d.failed_at,
    d.created_at
  FROM public.invoice_deliveries d
  WHERE d.company_id = p_company_id
    AND d.invoice_id = p_invoice_id
    AND d.status <> 'preparing'
  ORDER BY d.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) IS
  'Returns active-company invoice delivery status with masked To and CC addresses plus the attachment filename. Exact payload and BCC remain server-side.';

NOTIFY pgrst, 'reload schema';
