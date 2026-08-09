-- Harden customer-invoice delivery history after security and compliance review.
--
-- Delivery preparation is persisted before invoice number allocation. Exact
-- provider payloads remain immutable, while expired personal data is redacted
-- after the statutory accounting retention period. Audit rows contain metadata
-- only and never duplicate recipients or message bodies.

ALTER TABLE public.invoice_deliveries
  DROP CONSTRAINT invoice_deliveries_company_id_fkey,
  ADD CONSTRAINT invoice_deliveries_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  DROP CONSTRAINT invoice_deliveries_user_id_fkey,
  ADD CONSTRAINT invoice_deliveries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.invoice_deliveries
  ADD COLUMN retention_expires_at date,
  ADD COLUMN pii_redacted_at timestamptz;

-- Keep the WORM trigger active during backfill. This temporary function allows
-- exactly the new retention date to be initialized and preserves every existing
-- delivery field. It is replaced by the final state machine below.
CREATE OR REPLACE FUNCTION public.enforce_invoice_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice delivery history is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.retention_expires_at IS NULL
    AND NEW.retention_expires_at IS NOT NULL
    AND (to_jsonb(NEW) - 'retention_expires_at' - 'updated_at')
      IS NOT DISTINCT FROM
      (to_jsonb(OLD) - 'retention_expires_at' - 'updated_at')
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'terminal invoice delivery (%) is immutable', OLD.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'pending invoice delivery may only transition to sent or failed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.to_addresses IS DISTINCT FROM OLD.to_addresses
    OR NEW.cc_addresses IS DISTINCT FROM OLD.cc_addresses
    OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
    OR NEW.from_name IS DISTINCT FROM OLD.from_name
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.body_text IS DISTINCT FROM OLD.body_text
    OR NEW.body_html IS DISTINCT FROM OLD.body_html
    OR NEW.document_attachment_id IS DISTINCT FROM OLD.document_attachment_id
    OR NEW.attachment_filename IS DISTINCT FROM OLD.attachment_filename
    OR NEW.attachment_content_type IS DISTINCT FROM OLD.attachment_content_type
    OR NEW.attachment_sha256 IS DISTINCT FROM OLD.attachment_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'invoice delivery payload is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

UPDATE public.invoice_deliveries d
SET retention_expires_at = COALESCE(
  (
    SELECT fp.retention_expires_at
    FROM public.invoices i
    JOIN public.fiscal_periods fp
      ON fp.company_id = i.company_id
     AND i.invoice_date BETWEEN fp.period_start AND fp.period_end
    WHERE i.id = d.invoice_id
    ORDER BY fp.period_end DESC
    LIMIT 1
  ),
  (
    SELECT make_date(extract(year FROM i.invoice_date)::integer + 8, 1, 1)
    FROM public.invoices i
    WHERE i.id = d.invoice_id
  )
);

ALTER TABLE public.invoice_deliveries
  ALTER COLUMN retention_expires_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_invoice_delivery_retention_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.retention_expires_at IS NULL THEN
    SELECT COALESCE(
      (
        SELECT fp.retention_expires_at
        FROM public.fiscal_periods fp
        WHERE fp.company_id = i.company_id
          AND i.invoice_date BETWEEN fp.period_start AND fp.period_end
        ORDER BY fp.period_end DESC
        LIMIT 1
      ),
      make_date(extract(year FROM i.invoice_date)::integer + 8, 1, 1)
    )
    INTO NEW.retention_expires_at
    FROM public.invoices i
    WHERE i.id = NEW.invoice_id
      AND i.company_id = NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER set_invoice_delivery_retention_expiry
  BEFORE INSERT ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_invoice_delivery_retention_expiry();

ALTER TABLE public.invoice_deliveries
  DROP CONSTRAINT invoice_deliveries_status_check,
  ADD CONSTRAINT invoice_deliveries_status_check
    CHECK (status IN ('preparing', 'pending', 'sent', 'failed', 'marked_sent')),
  DROP CONSTRAINT invoice_deliveries_payload_shape,
  ADD CONSTRAINT invoice_deliveries_payload_shape CHECK (
    (
      channel = 'email'
      AND status = 'preparing'
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider IS NULL
      AND provider_message_id IS NULL
      AND error_code IS NULL
      AND document_attachment_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_content_type IS NULL
      AND attachment_sha256 IS NULL
      AND pii_redacted_at IS NULL
    )
    OR
    (
      channel = 'email'
      AND status IN ('pending', 'sent', 'failed')
      AND pii_redacted_at IS NULL
      AND cardinality(to_addresses) > 0
      AND subject IS NOT NULL
      AND body_text IS NOT NULL
      AND body_html IS NOT NULL
      AND attachment_filename IS NOT NULL
      AND attachment_content_type IS NOT NULL
      AND attachment_sha256 IS NOT NULL
      AND (
        (status IN ('pending', 'sent') AND document_attachment_id IS NOT NULL)
        OR status = 'failed'
      )
    )
    OR
    (
      channel = 'email'
      AND status IN ('sent', 'failed')
      AND pii_redacted_at IS NOT NULL
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider_message_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_sha256 IS NULL
    )
    OR
    (
      channel = 'manual'
      AND status = 'marked_sent'
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider IS NULL
      AND provider_message_id IS NULL
      AND error_code IS NULL
      AND document_attachment_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_content_type IS NULL
      AND attachment_sha256 IS NULL
      AND pii_redacted_at IS NULL
    )
  ),
  DROP CONSTRAINT invoice_deliveries_terminal_timestamps,
  ADD CONSTRAINT invoice_deliveries_terminal_timestamps CHECK (
    (status IN ('sent', 'marked_sent') AND sent_at IS NOT NULL AND failed_at IS NULL)
    OR (status = 'failed' AND sent_at IS NULL AND failed_at IS NOT NULL)
    OR (status IN ('preparing', 'pending') AND sent_at IS NULL AND failed_at IS NULL)
  );

CREATE UNIQUE INDEX idx_invoice_deliveries_preparing_invoice
  ON public.invoice_deliveries (company_id, invoice_id)
  WHERE status = 'preparing';

CREATE OR REPLACE FUNCTION public.invoice_delivery_audit_state(
  delivery public.invoice_deliveries
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', delivery.id,
    'company_id', delivery.company_id,
    'user_id', delivery.user_id,
    'invoice_id', delivery.invoice_id,
    'channel', delivery.channel,
    'status', delivery.status,
    'document_attachment_id', delivery.document_attachment_id,
    'provider', delivery.provider,
    'error_code', delivery.error_code,
    'sent_at', delivery.sent_at,
    'failed_at', delivery.failed_at,
    'retention_expires_at', delivery.retention_expires_at,
    'pii_redacted_at', delivery.pii_redacted_at,
    'created_at', delivery.created_at
  )
$$;

CREATE OR REPLACE FUNCTION public.write_invoice_delivery_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description
  ) VALUES (
    CASE WHEN TG_OP = 'INSERT' THEN NEW.user_id ELSE COALESCE(NEW.user_id, OLD.user_id) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.company_id ELSE COALESCE(NEW.company_id, OLD.company_id) END,
    TG_OP,
    'invoice_deliveries',
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE COALESCE(NEW.id, OLD.id) END,
    auth.uid(),
    CASE WHEN TG_OP = 'UPDATE' THEN public.invoice_delivery_audit_state(OLD) END,
    public.invoice_delivery_audit_state(NEW),
    'Invoice delivery metadata changed. Recipient and message content excluded.'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_invoice_delivery_metadata
  AFTER INSERT OR UPDATE ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.write_invoice_delivery_audit();

CREATE OR REPLACE FUNCTION public.enforce_invoice_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_log (
      user_id,
      company_id,
      action,
      table_name,
      record_id,
      actor_id,
      old_state,
      description
    ) VALUES (
      OLD.user_id,
      OLD.company_id,
      'SECURITY_EVENT',
      'invoice_deliveries',
      OLD.id,
      auth.uid(),
      public.invoice_delivery_audit_state(OLD),
      'Blocked deletion of immutable invoice delivery history.'
    );
    RETURN NULL;
  END IF;

  IF OLD.status = 'preparing' THEN
    IF NEW.status <> 'pending'
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.channel IS DISTINCT FROM OLD.channel
      OR NEW.provider IS NOT NULL
      OR NEW.provider_message_id IS NOT NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.sent_at IS NOT NULL
      OR NEW.failed_at IS NOT NULL
      OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
      OR NEW.pii_redacted_at IS NOT NULL
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'preparing invoice delivery may only capture its pending payload'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status NOT IN ('sent', 'failed') THEN
      RAISE EXCEPTION 'pending invoice delivery may only transition to sent or failed'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.channel IS DISTINCT FROM OLD.channel
      OR NEW.to_addresses IS DISTINCT FROM OLD.to_addresses
      OR NEW.cc_addresses IS DISTINCT FROM OLD.cc_addresses
      OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
      OR NEW.from_name IS DISTINCT FROM OLD.from_name
      OR NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.body_text IS DISTINCT FROM OLD.body_text
      OR NEW.body_html IS DISTINCT FROM OLD.body_html
      OR NEW.attachment_filename IS DISTINCT FROM OLD.attachment_filename
      OR NEW.attachment_content_type IS DISTINCT FROM OLD.attachment_content_type
      OR NEW.attachment_sha256 IS DISTINCT FROM OLD.attachment_sha256
      OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
      OR NEW.pii_redacted_at IS DISTINCT FROM OLD.pii_redacted_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (
        NEW.status = 'sent'
        AND NEW.document_attachment_id IS DISTINCT FROM OLD.document_attachment_id
      )
      OR (
        NEW.status = 'failed'
        AND NEW.document_attachment_id IS NOT NULL
      )
    THEN
      RAISE EXCEPTION 'invoice delivery payload is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('sent', 'failed')
    AND OLD.pii_redacted_at IS NULL
    AND CURRENT_DATE >= OLD.retention_expires_at
    AND NEW.pii_redacted_at IS NOT NULL
    AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
    AND NEW.channel IS NOT DISTINCT FROM OLD.channel
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND cardinality(NEW.to_addresses) = 0
    AND cardinality(NEW.cc_addresses) = 0
    AND NEW.reply_to IS NULL
    AND NEW.from_name IS NULL
    AND NEW.subject IS NULL
    AND NEW.body_text IS NULL
    AND NEW.body_html IS NULL
    AND NEW.provider IS NOT DISTINCT FROM OLD.provider
    AND NEW.provider_message_id IS NULL
    AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
    AND NEW.document_attachment_id IS NOT DISTINCT FROM OLD.document_attachment_id
    AND NEW.attachment_filename IS NULL
    AND NEW.attachment_content_type IS NOT DISTINCT FROM OLD.attachment_content_type
    AND NEW.attachment_sha256 IS NULL
    AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at
    AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
    AND NEW.retention_expires_at IS NOT DISTINCT FROM OLD.retention_expires_at
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'terminal invoice delivery (%) is immutable', OLD.status
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.redact_expired_invoice_delivery_pii()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  redacted_count integer;
BEGIN
  UPDATE public.invoice_deliveries
  SET to_addresses = '{}',
      cc_addresses = '{}',
      reply_to = NULL,
      from_name = NULL,
      subject = NULL,
      body_text = NULL,
      body_html = NULL,
      provider_message_id = NULL,
      attachment_filename = NULL,
      attachment_sha256 = NULL,
      pii_redacted_at = now()
  WHERE channel = 'email'
    AND status IN ('sent', 'failed')
    AND pii_redacted_at IS NULL
    AND retention_expires_at <= CURRENT_DATE;

  GET DIAGNOSTICS redacted_count = ROW_COUNT;
  RETURN redacted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.redact_expired_invoice_delivery_pii() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redact_expired_invoice_delivery_pii() TO service_role;

SELECT cron.schedule(
  'redact-expired-invoice-delivery-pii',
  '15 3 * * *',
  $$SELECT public.redact_expired_invoice_delivery_pii()$$
);

COMMENT ON COLUMN public.invoice_deliveries.retention_expires_at IS
  'First date after the BFL 7 kap statutory minimum. Recipient and message PII is redacted on or after this date.';
COMMENT ON FUNCTION public.redact_expired_invoice_delivery_pii() IS
  'Daily storage-limitation control that removes invoice delivery PII after the statutory retention period.';

NOTIFY pgrst, 'reload schema';
