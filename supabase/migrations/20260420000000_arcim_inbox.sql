-- Arcim inbox: per-company @arcim.io email address for Resend Inbound
-- Replaces the Gmail OAuth model with a push-based inbound webhook flow.
--
-- Changes:
--   1. New company_inboxes table with one active address per company
--   2. Extend invoice_inbox_items with resend_email_id (idempotency) and email_body_text
--   3. Drop the obsolete email_connections table (no production data; extension was disabled)
--   4. generate_inbox_local_part() function: slug + 4-char suffix from a 30-char alphabet
--   5. Auto-provision trigger on companies INSERT
--   6. One-time backfill for existing companies

-- =============================================================================
-- 1. company_inboxes table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_inboxes (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  local_part    text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'deprecated', 'blocked')),
  slug_seed     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deprecated_at timestamptz
);

-- Globally unique addresses across all rows (deprecated rows keep their local_part reserved)
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_inboxes_local_part
  ON public.company_inboxes(local_part);

-- One active inbox per company at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_inboxes_company_active
  ON public.company_inboxes(company_id) WHERE status = 'active';

-- Lookup by company
CREATE INDEX IF NOT EXISTS idx_company_inboxes_company
  ON public.company_inboxes(company_id);

-- RLS
ALTER TABLE public.company_inboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_inboxes_select" ON public.company_inboxes
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_inboxes_insert" ON public.company_inboxes
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_inboxes_update" ON public.company_inboxes
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- updated_at trigger
CREATE TRIGGER company_inboxes_updated_at
  BEFORE UPDATE ON public.company_inboxes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. Extend invoice_inbox_items
-- =============================================================================

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS resend_email_id text,
  ADD COLUMN IF NOT EXISTS email_body_text text;

-- Idempotency: Resend retries the webhook on our failures; a unique index rejects duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_items_resend_email_id
  ON public.invoice_inbox_items(resend_email_id)
  WHERE resend_email_id IS NOT NULL;

-- =============================================================================
-- 3. Drop obsolete email_connections (Gmail OAuth storage)
-- =============================================================================

DROP TABLE IF EXISTS public.email_connections;

-- =============================================================================
-- 4. generate_inbox_local_part(): slugify company name + 4-char suffix
-- =============================================================================

CREATE OR REPLACE FUNCTION public.generate_inbox_local_part(p_company_name text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  -- Crockford-ish base32 without ambiguous chars (no i/l/o/u, digits 2-9)
  v_alphabet constant text := 'abcdefghjkmnpqrstvwxyz23456789';
  v_alphabet_len constant int := 30;
  v_slug text;
  v_suffix text;
  v_candidate text;
  v_attempt int := 0;
  v_max_attempts constant int := 20;
BEGIN
  -- Slugify: normalize Swedish vowels, strip accents, lowercase, non-alnum → hyphen
  v_slug := lower(COALESCE(p_company_name, ''));
  v_slug := translate(v_slug, 'åäöéèêàâüñ', 'aaoeeeaaun');
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');
  v_slug := substring(v_slug from 1 for 24);
  v_slug := regexp_replace(v_slug, '-+$', '', 'g');

  IF v_slug IS NULL OR v_slug = '' THEN
    v_slug := 'company';
  END IF;

  LOOP
    v_attempt := v_attempt + 1;

    -- Build a 4-char suffix
    v_suffix := '';
    FOR i IN 1..4 LOOP
      v_suffix := v_suffix || substr(v_alphabet, 1 + floor(random() * v_alphabet_len)::int, 1);
    END LOOP;

    v_candidate := v_slug || '-' || v_suffix;

    IF NOT EXISTS (SELECT 1 FROM public.company_inboxes WHERE local_part = v_candidate) THEN
      RETURN v_candidate;
    END IF;

    IF v_attempt >= v_max_attempts THEN
      RAISE EXCEPTION 'Failed to generate unique inbox local_part after % attempts for slug %', v_max_attempts, v_slug;
    END IF;
  END LOOP;
END;
$$;

-- =============================================================================
-- 5. Auto-provision trigger on companies INSERT
-- =============================================================================

CREATE OR REPLACE FUNCTION public.auto_provision_company_inbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_part text;
  v_slug_seed text;
BEGIN
  v_local_part := public.generate_inbox_local_part(NEW.name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (NEW.id, v_local_part, v_slug_seed, 'active');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_auto_provision_inbox ON public.companies;
CREATE TRIGGER companies_auto_provision_inbox
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.auto_provision_company_inbox();

-- =============================================================================
-- 6. Backfill existing companies
-- =============================================================================

DO $$
DECLARE
  c RECORD;
  v_local_part text;
  v_slug_seed text;
BEGIN
  FOR c IN
    SELECT co.id, co.name
    FROM public.companies co
    WHERE NOT EXISTS (
      SELECT 1 FROM public.company_inboxes ci WHERE ci.company_id = co.id
    )
  LOOP
    v_local_part := public.generate_inbox_local_part(c.name);
    v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');
    INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
    VALUES (c.id, v_local_part, v_slug_seed, 'active');
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
