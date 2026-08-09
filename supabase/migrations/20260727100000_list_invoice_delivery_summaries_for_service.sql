-- Service-role sibling of list_invoice_delivery_summaries.
--
-- An agent chasing an unpaid invoice needs to see that the invoice mail
-- bounced, but the cookie-session function cannot serve it. That function
-- authorizes on auth.uid() and requires p_company_id to equal
-- current_active_company_id(). The MCP server runs on a cookieless service
-- role client (auth.uid() is NULL) and deliberately routes to the company the
-- API key names, which is frequently not the user's active company. Both
-- checks therefore reject every MCP call.
--
-- The fix is a sibling that takes the acting user explicitly and re-verifies
-- membership server-side, mirroring authorize_invoice_delivery_service_actor
-- (20260723003000) and how reserve_invoice_delivery,
-- capture_invoice_delivery_payload and finalize_invoice_delivery use it: the
-- service role alone proves nothing about which tenant may be read, so the
-- caller-supplied user id is checked against company_members here rather than
-- trusted from the route.
--
-- Membership is checked without a role filter, unlike the write actor helper:
-- this is the read path, and the cookie-session function already exposes the
-- same summary to every member including viewers. Widening or narrowing that
-- audience is not part of this change.
--
-- The returned shape is a byte-for-byte mirror of
-- list_invoice_delivery_summaries as redefined in 20260724160000: To and CC
-- are masked to '***@domain', the provider reason text has its address local
-- parts masked the same way, and body_html, body_text and bcc_addresses are
-- never selected at all. That minimization is the privacy control, so this
-- function must never return more than its sibling.
--
-- Read-only: invoice_deliveries stays an append-only WORM evidence table and
-- no trigger, policy or constraint on it is touched here.

CREATE OR REPLACE FUNCTION public.list_invoice_delivery_summaries_for_service(
  p_company_id uuid,
  p_user_id uuid,
  p_invoice_id uuid
)
RETURNS TABLE (
  id uuid,
  channel text,
  status text,
  to_addresses text[],
  cc_addresses text[],
  provider text,
  provider_status text,
  provider_status_at timestamptz,
  provider_status_detail text,
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
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'invoice delivery summaries require a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'invoice delivery reader is not a company member'
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
    d.provider_status,
    d.provider_status_at,
    regexp_replace(d.provider_status_detail, '[A-Za-z0-9._%+-]+@', '***@', 'g'),
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

REVOKE ALL ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid) IS
  'Service-role read of invoice delivery status, including the provider delivery outcome, for a company member named by the server. Same masked shape as list_invoice_delivery_summaries: exact payload and BCC remain server-side.';

NOTIFY pgrst, 'reload schema';
