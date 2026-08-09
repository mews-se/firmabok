-- Skattekonto transaction store
--
-- Mirrors transactions fetched from Skatteverket's Skattekonto API v2:
--   GET /skattekonton/{omfragad}/transaktioner
-- Each row is either a booked (tidigare) or upcoming (kommande) transaction.
-- Amounts are kept in SEK matching Skatteverket's sign convention
-- (positive = credit on the tax account, negative = debit / debt).
--
-- Idempotent ingestion: dedup_key is unique per company. When a "kommande"
-- transaction graduates to "tidigare", the same dedup_key resolves and the
-- row is updated in place (status flips, transaktionsidentitet populated).

CREATE TABLE public.skattekonto_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies ON DELETE CASCADE,

  -- Skatteverket's stable transaction id. Present on tidigare; often null
  -- on kommande. We do NOT use it as a unique constraint because it can
  -- be missing — see dedup_key below.
  transaktionsidentitet BIGINT,

  -- Stable dedup key: transaktionsidentitet when present, otherwise a
  -- sha256 hex of (transaktionsdatum|beloppSkatteverket|transaktionstext).
  -- Application code computes this; the unique constraint below enforces it.
  dedup_key TEXT NOT NULL,

  transaktionsdatum DATE NOT NULL,
  forfallodatum DATE,                   -- only on kommande
  ranteberakningsdatum DATE,
  transaktionstext TEXT NOT NULL,

  belopp_skatteverket NUMERIC(14, 2) NOT NULL,
  belopp_kronofogden NUMERIC(14, 2),

  status TEXT NOT NULL CHECK (status IN ('booked', 'upcoming')),

  -- When the user clicks "Bokför", a draft journal entry is created and
  -- linked here. SET NULL on entry delete so this row can be re-bookförd.
  journal_entry_id UUID REFERENCES public.journal_entries ON DELETE SET NULL,

  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, dedup_key)
);

CREATE INDEX skattekonto_transactions_company_date_idx
  ON public.skattekonto_transactions (company_id, transaktionsdatum DESC);

CREATE INDEX skattekonto_transactions_company_status_idx
  ON public.skattekonto_transactions (company_id, status);

-- RLS — company-scoped via the user_company_ids() helper
ALTER TABLE public.skattekonto_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see skattekonto transactions for their companies"
  ON public.skattekonto_transactions FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "Users insert skattekonto transactions for their companies"
  ON public.skattekonto_transactions FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "Users update skattekonto transactions for their companies"
  ON public.skattekonto_transactions FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "Users delete skattekonto transactions for their companies"
  ON public.skattekonto_transactions FOR DELETE
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER update_skattekonto_transactions_updated_at
  BEFORE UPDATE ON public.skattekonto_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
