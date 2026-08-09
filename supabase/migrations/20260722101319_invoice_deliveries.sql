-- Durable customer-invoice delivery history.
--
-- One row represents one delivery attempt. Email payload fields and the exact
-- archived PDF are captured before the provider call, then only the pending
-- status may transition to sent or failed. Manual marks deliberately contain
-- no recipient or payload because Accounted did not perform that delivery.

CREATE TABLE public.invoice_deliveries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invoice_id               uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,

  channel                  text NOT NULL CHECK (channel IN ('email', 'manual')),
  status                   text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'marked_sent')),

  to_addresses             text[] NOT NULL DEFAULT '{}',
  cc_addresses             text[] NOT NULL DEFAULT '{}',
  reply_to                 text,
  from_name                text,
  subject                  text,
  body_text                text,
  body_html                text,

  provider                 text,
  provider_message_id      text,
  error_code               text,

  document_attachment_id   uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  attachment_filename      text,
  attachment_content_type  text,
  attachment_sha256        text,

  sent_at                  timestamptz,
  failed_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_deliveries_payload_shape CHECK (
    (
      channel = 'email'
      AND status IN ('pending', 'sent', 'failed')
      AND cardinality(to_addresses) > 0
      AND subject IS NOT NULL
      AND body_text IS NOT NULL
      AND body_html IS NOT NULL
      AND document_attachment_id IS NOT NULL
      AND attachment_filename IS NOT NULL
      AND attachment_content_type IS NOT NULL
      AND attachment_sha256 IS NOT NULL
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
    )
  ),
  CONSTRAINT invoice_deliveries_terminal_timestamps CHECK (
    (status IN ('sent', 'marked_sent') AND sent_at IS NOT NULL AND failed_at IS NULL)
    OR (status = 'failed' AND sent_at IS NULL AND failed_at IS NOT NULL)
    OR (status = 'pending' AND sent_at IS NULL AND failed_at IS NULL)
  )
);

COMMENT ON TABLE public.invoice_deliveries IS
  'Immutable delivery attempts for customer invoices, including exact email payload and archived PDF snapshot.';
COMMENT ON COLUMN public.invoice_deliveries.body_html IS
  'Exact HTML alternative submitted to the email provider. Never render directly in the dashboard DOM.';
COMMENT ON COLUMN public.invoice_deliveries.document_attachment_id IS
  'Exact PDF submitted as the email attachment. The FK and deletion trigger keep sent snapshots in the WORM archive.';

ALTER TABLE public.invoice_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_deliveries_select
  ON public.invoice_deliveries FOR SELECT TO public
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY invoice_deliveries_insert
  ON public.invoice_deliveries FOR INSERT TO public
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

CREATE POLICY invoice_deliveries_update
  ON public.invoice_deliveries FOR UPDATE TO public
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

-- No DELETE policy. Delivery evidence is append-only, and the trigger below
-- also blocks service-role or future policy bypasses.

CREATE INDEX idx_invoice_deliveries_invoice_created
  ON public.invoice_deliveries (invoice_id, created_at DESC);
CREATE INDEX idx_invoice_deliveries_company_created
  ON public.invoice_deliveries (company_id, created_at DESC);
CREATE UNIQUE INDEX idx_invoice_deliveries_provider_message
  ON public.invoice_deliveries (provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_invoice_delivery_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = NEW.invoice_id
      AND i.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'invoice delivery invoice/company mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.document_attachment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.document_attachments da
    WHERE da.id = NEW.document_attachment_id
      AND da.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'invoice delivery document/company mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_invoice_delivery_tenant
  BEFORE INSERT OR UPDATE ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_delivery_tenant();

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

CREATE TRIGGER enforce_invoice_delivery_update_immutability
  BEFORE UPDATE ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_delivery_immutability();
CREATE TRIGGER enforce_invoice_delivery_delete_immutability
  BEFORE DELETE ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_delivery_immutability();

CREATE OR REPLACE FUNCTION public.block_sent_invoice_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoice_deliveries d
    WHERE d.document_attachment_id = OLD.id
      AND d.status = 'sent'
  ) THEN
    RAISE EXCEPTION 'retention: document is the exact PDF sent with a customer invoice'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER block_sent_invoice_document_deletion
  BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.block_sent_invoice_document_deletion();

CREATE TRIGGER set_updated_at_invoice_deliveries
  BEFORE UPDATE ON public.invoice_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
