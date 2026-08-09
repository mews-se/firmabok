-- Artikelregister (product/article catalog) — app-level master data.
--
-- A lean, NON-INVENTORY article register modeled on the multi-tenant customers
-- pattern. Articles are reusable invoice-line presets: name, unit, price excl
-- VAT, VAT rate, and an optional revenue-account override. There is deliberately
-- NO stock/lager column and NO inventory posting — a scope boundary matching our
-- sole-trader + small-AB positioning (see the artikelregister plan). Articles are
-- master data, not a journal, so they carry no BFL sequence/immutability
-- obligation. The booking is frozen onto invoice_items at line-create time, so
-- editing or deactivating an article never moves a posted voucher.

-- =============================================================================
-- 1. articles
-- =============================================================================
CREATE TABLE public.articles (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_number  text,
  name            text NOT NULL,
  name_en         text,
  type            text NOT NULL DEFAULT 'tjanst' CHECK (type IN ('vara', 'tjanst')),
  unit            text NOT NULL DEFAULT 'st',
  price_excl_vat  numeric NOT NULL DEFAULT 0,
  vat_rate        integer NOT NULL DEFAULT 25 CHECK (vat_rate IN (0, 6, 12, 25)),
  revenue_account text,            -- optional BAS class-3 override; NULL = derive from VAT treatment
  cost_price      numeric,         -- margin/display only; never posted to the ledger
  ean             text,
  housework_type  text,            -- ROT/RUT arbetstyp (tjanst only); pre-fills the invoice line
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company articles"
  ON public.articles FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company articles"
  ON public.articles FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company articles"
  ON public.articles FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company articles"
  ON public.articles FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_articles_company_id ON public.articles (company_id);
-- Active-only list/search is the hot path; keep it covered without scanning archived rows.
CREATE INDEX idx_articles_company_active ON public.articles (company_id, name) WHERE active;
-- Article number is the import/lookup key; unique per company when present.
CREATE UNIQUE INDEX uq_articles_company_number
  ON public.articles (company_id, article_number) WHERE article_number IS NOT NULL;

CREATE TRIGGER set_updated_at_articles
  BEFORE UPDATE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_articles
  AFTER INSERT OR UPDATE OR DELETE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. company_settings.next_article_number — per-company auto-number counter
-- =============================================================================
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_article_number integer NOT NULL DEFAULT 1;

-- =============================================================================
-- 3. generate_article_number RPC — atomic + idempotent
--    (mirrors generate_invoice_number: row lock, idempotent return, atomic
--     counter via UPDATE ... RETURNING). Article numbers are master data, so a
--     gap from a manual override colliding with the counter is harmless.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_article_number(
  p_company_id uuid,
  p_article_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing text;
  v_number integer;
  v_final text;
BEGIN
  -- 1. Lock the article row; concurrent callers serialize here and, on retry,
  --    see the persisted number.
  SELECT article_number INTO v_existing
  FROM public.articles
  WHERE id = p_article_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article % not found in company %', p_article_id, p_company_id;
  END IF;

  -- 2. Idempotent: keep an already-assigned number; never consume a sequence twice.
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 3. Allocate from the per-company counter atomically.
  UPDATE public.company_settings
  SET next_article_number = next_article_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_article_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  -- 4. Plain sequential number as text. Master data: no year prefix, no padding.
  v_final := v_number::text;

  -- 5. Persist on the article row in the same transaction.
  UPDATE public.articles
  SET article_number = v_final
  WHERE id = p_article_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

-- =============================================================================
-- 4. invoice_items: per-line revenue-account override + article back-reference
-- =============================================================================
-- revenue_account is COPIED from the article at line-create time (frozen), so a
-- later article edit never moves a posted voucher. NULL preserves the existing
-- "derive the revenue account from the VAT treatment" behaviour in
-- generatePerRateLines(). article_id is a soft back-reference for the future
-- "Affärshändelser" tab; ON DELETE SET NULL keeps frozen line values intact if
-- the article is ever hard-deleted.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS revenue_account text;
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS article_id uuid REFERENCES public.articles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_items_article_id ON public.invoice_items (article_id);

NOTIFY pgrst, 'reload schema';
