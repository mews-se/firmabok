-- BankID enrichment is user-level data fetched immediately after BankID auth,
-- before the user has selected or created a company. It cannot live in
-- extension_data, which migration 20260330130000 made company-scoped
-- (company_id NOT NULL). Every BankID signup since that refactor has silently
-- failed to persist enrichment because of the NOT NULL violation.

CREATE TABLE public.bankid_enrichment (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  enriched_at_utc TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bankid_enrichment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own enrichment" ON public.bankid_enrichment
  FOR SELECT USING (auth.uid() = user_id);

-- Writes happen only via service role (createServiceClient) inside the
-- TIC extension's BankID complete handler, so no user-facing INSERT/UPDATE
-- policy is needed. Service role bypasses RLS.

CREATE TRIGGER set_updated_at_bankid_enrichment
  BEFORE UPDATE ON public.bankid_enrichment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
