-- Provider consents for direct accounting provider integrations
-- Replaces the external dependency on the Arcim Sync gateway

-- Provider consents (one per connected accounting company)
CREATE TABLE IF NOT EXISTS provider_consents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,  -- 0=Created, 1=Accepted, 2=Revoked, 3=Inactive
  provider TEXT,  -- fortnox, visma, briox, bokio, bjornlunden
  org_number TEXT,
  company_name TEXT,
  etag TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_provider_consents_company ON provider_consents(company_id);
CREATE INDEX idx_provider_consents_company_provider ON provider_consents(company_id, provider);

ALTER TABLE provider_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_consents_select ON provider_consents
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY provider_consents_insert ON provider_consents
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY provider_consents_update ON provider_consents
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY provider_consents_delete ON provider_consents
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER update_provider_consents_updated_at
  BEFORE UPDATE ON provider_consents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Encrypted token storage for provider OAuth/API tokens
CREATE TABLE IF NOT EXISTS provider_consent_tokens (
  consent_id UUID PRIMARY KEY REFERENCES provider_consents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  provider_company_id TEXT,
  scopes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE provider_consent_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_consent_tokens_select ON provider_consent_tokens
  FOR SELECT USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_consent_tokens_insert ON provider_consent_tokens
  FOR INSERT WITH CHECK (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_consent_tokens_update ON provider_consent_tokens
  FOR UPDATE USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_consent_tokens_delete ON provider_consent_tokens
  FOR DELETE USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE TRIGGER update_provider_consent_tokens_updated_at
  BEFORE UPDATE ON provider_consent_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One-time codes for OAuth callback validation
CREATE TABLE IF NOT EXISTS provider_otc (
  code TEXT PRIMARY KEY,
  consent_id UUID NOT NULL REFERENCES provider_consents(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX idx_provider_otc_consent ON provider_otc(consent_id);

ALTER TABLE provider_otc ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_otc_select ON provider_otc
  FOR SELECT USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_otc_insert ON provider_otc
  FOR INSERT WITH CHECK (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_otc_update ON provider_otc
  FOR UPDATE USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));

CREATE POLICY provider_otc_delete ON provider_otc
  FOR DELETE USING (consent_id IN (
    SELECT id FROM provider_consents WHERE company_id IN (
      SELECT company_id FROM team_members WHERE user_id = auth.uid()
    )
  ));
