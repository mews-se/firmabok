-- Migration: arsredovisning_signature_requests — captures the multi-signer
-- BankID fastställelseintyg flow för Bolagsverket-inlämning av årsredovisning.
--
-- Each row = one signature slot för one styrelseledamot or VD on a specific
-- fiscal period's årsredovisning. Status transitions: pending → signed (or
-- declined). When all rows för a fiscal period are signed, the
-- årsredovisning is "fastställd" and may be filed.
--
-- The actual BankID call is not wired in this migration — that integration
-- ships in a follow-up that wires the existing lib/auth/bankid helpers to
-- the sign action. This table + the service helpers make the request layer
-- available so the UI can render the signature slots and persist results
-- when the BankID side is hooked up.

CREATE TABLE public.arsredovisning_signature_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_period_id    UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE CASCADE,
  -- Free-text role to keep flexibility for "Styrelseordförande", "VD",
  -- "Revisor" etc. without a migration.
  role                TEXT NOT NULL CHECK (length(role) > 0),
  signer_name         TEXT NOT NULL CHECK (length(signer_name) > 0),
  /** Encrypted personnummer of the signer (12 digits). Optional at request
   *  time, filled when BankID completes. Stored via the same crypto
   *  helpers as bankid_identities (see lib/auth/bankid.ts). */
  signer_personnummer_encrypted BYTEA,
  signer_personnummer_hash      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'signed', 'declined'
  )),
  signed_at           TIMESTAMPTZ,
  /** Raw BankID completion data — JWT or JSON depending on provider. Stored
   *  for audit; never read back to make trust decisions. */
  bankid_signature_data JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT arsredovisning_signature_requests_signed_atomic CHECK (
    (status <> 'signed' AND signed_at IS NULL)
    OR (status = 'signed' AND signed_at IS NOT NULL)
  )
);

CREATE INDEX idx_arsredovisning_sigreq_company ON public.arsredovisning_signature_requests (company_id);
CREATE INDEX idx_arsredovisning_sigreq_period ON public.arsredovisning_signature_requests (fiscal_period_id);

ALTER TABLE public.arsredovisning_signature_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "arsredovisning_sigreq_select" ON public.arsredovisning_signature_requests
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "arsredovisning_sigreq_insert" ON public.arsredovisning_signature_requests
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "arsredovisning_sigreq_update" ON public.arsredovisning_signature_requests
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
-- Block DELETE on signed rows — signed signatures must persist för audit.
CREATE POLICY "arsredovisning_sigreq_delete" ON public.arsredovisning_signature_requests
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
    AND status <> 'signed'
  );

CREATE TRIGGER arsredovisning_sigreq_updated_at
  BEFORE UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Once status='signed', the financial fields cannot be amended. Mirrors the
-- pattern in 20260516120000_assets_and_depreciation.sql.
CREATE OR REPLACE FUNCTION public.enforce_signed_signature_request_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.signer_name IS DISTINCT FROM OLD.signer_name
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Cannot modify a signed signature request (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_signed_signature_request_immutability
  BEFORE UPDATE ON public.arsredovisning_signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_signed_signature_request_immutability();

NOTIFY pgrst, 'reload schema';
